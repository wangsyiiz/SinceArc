# 消息模型：原子事件 → 块 → 消息 → 轮

> 由来：E13 之后消息形式膨胀到 14 个 kind，散在 `messages`（正文/派活/旁注）与 `session_events`
> （思考/工具/权限/用量/命令/委派）两张表里，`kind` 是自由字符串、正文不带 `turn_id`、
> `delegate` 同一件事写两份。所有者定的方向：**先给数据设一个最低单位，由它逐层包装出上层对象，
> 再明确消息类型与消息关系，最后才谈改哪里**；并且要求这套模型**有扩展性 —— 以后加功能只加注册项，
> 不改现有结构**。
>
> 本文只定模型与规则（M0）。改表（M1）与合一（M2）的口径在 §9，动手前不再重新讨论结构。

## 1. 最低单位：原子事件（atom）

一条不可变、只追加的记录。所有其它的东西都是它的派生视图：

| 字段 | 语义 | 说明 |
|---|---|---|
| `id` | 稳定唯一 | 合并、重放都不改变它 |
| `session_id` | 界面会话 | 分层 L2；`docs/data-plane.md` 的键 |
| `turn_id` | 属于哪一轮 | **必填或显式为空**（握手、命令列表这类不属于任何轮） |
| `seq` | 投递顺序 | 会话内单调；同一块的碎片按它排 |
| `at` | 发生时刻 | 毫秒 |
| `actor` | 谁产生 | `user` / `agent` / `member:<id>` / `system` / `tool` |
| `kind` | 类型 | 枚举，注册见 §4 |
| `schema` | `payload` 的版本 | 形如 `text/1`、`tool_call/2` |
| `payload` | 该 kind 的正文 | 该 kind 自己的 schema，原样存 |
| `refs` | 命名关联 | `{ messageId, toolCallId, requestId, handleId, parentAtomId, childSession, … }` |
| `ext` | 扩展属性 | 键必须 `x.<domain>.<name>` |
| `source` | `live` / `replay` | 恢复与回放要能区分 |
| `truncated` | 是否截断 | 超限时的显式标记 |

三条不变式：

1. **不可变**。变更只能追加：工具状态变更追加 `tool_call_update`，权限裁决追加
   `permission_decision`。任何「就地改上一行」都是错。
2. **幂等键**：`(kind, refs 定位键, seq)`。重放同一段流必须落成同一条 atom；
   现在的 `UNIQUE(session_id, seq)` 只保证会话内不撞号，不保证「同一段流被重放两次还是一条」。
3. **归属明确**：`turn_id` 要么指向一轮，要么显式为空。不允许「不知道是谁的」—— 正文现在正是这个状态。

## 2. 扩展性：加东西不改结构

四层可扩展点，各自解决一类「以后要加」：

### 2.1 `ext`：附加属性（不参与语义与渲染）

- 键必须 `x.<domain>.<name>`，例：`x.sincearc.trace_level`、`x.agent.thread_id`。
- **未注册的键一律原样保存**：渲染层忽略、诊断层可查、导出保留。
- `ext` 不许承载「渲染必需」的信息 —— 一旦某键影响显示，它就该升级成 `payload` 字段（见 §7）。
- 兜底：`ext` 里出现任何未知键，不报错、不丢弃、不改变现有渲染。

### 2.2 `refs`：命名关联（不动表结构就能加关系）

关系不再是固定列，而是命名键：

```
refs.messageId     流式碎片属于哪条消息（插话归因正在用它）
refs.toolCallId    工具块的主键
refs.requestId     权限请求 / 裁决
refs.handleId      派活句柄
refs.parentAtomId  父子串接（不新增 kind 也能挂从属数据）
refs.childSession  派活派出去的那条会话
```

要加一种新关系 → 加一个命名键 + 在 §6 登记；不需要加列、不需要迁移。

### 2.3 `schema`：payload 版本（前向兼容）

- 读方必须**容忍未知字段**（读到不认识的字段忽略，不报错）。
- 写方新增字段一律**可选且带默认值**；删字段/改语义视为破坏性变更 → 换 kind，或把版本升到 `kind/2`
  并保留旧版本的读法。
- 兜底：`schema` 主版本不认识 → 按「未知 kind」处理（§2.4），不猜。

### 2.4 kind 注册表（代码内，不是数据库表）

每个 kind 一条注册项，新功能 = 加注册项，**不改现有分支**：

```
kind        名称
chat        是否进聊天区（true/false，见 §3.2）
merge       合并规约：stream | tool | request | none
payload     payload schema（ts 类型 + 校验）
renderer    渲染器 id；chat=true 时必填
owner       谁负责这份能力（排障时找谁）
```

**兜底**：未被注册的 kind 一律按「过程条目」处理 —— 进轨迹、显示成「未知类型 + payload 摘要」、
绝不进聊天区、绝不丢弃、绝不让界面报错。agent 明天发来一个新 kind，客户端照样能把会话跑完。

## 3. 三层包装

### 3.1 块（block）：运行期派生，**不落库**

把同源碎片合并成用户可读的单元，规约只有三种：

| 规约 | 键 | 合并方式 |
|---|---|---|
| `stream` | `(session_id, refs.messageId, kind)` | 连续 chunk 拼成一个块；`messageId` 变了就是新块 |
| `tool` | `refs.toolCallId` | `tool_call` + 若干 `tool_call_update` → 一块，状态取最后一条 |
| `request` | `refs.requestId` | `permission` + `permission_decision` → 一块，结论取裁决 |

不落库的理由：块是查询视图，存下来就和 atom 两份真相。任何需要「块」的地方现算一次。

### 3.2 消息（message）：用户看到的一条

一条消息 = 一个主块 + 若干附属块，类型由注册项 `chat=true` 决定。

聊天区白名单（当前）：
`text.user` / `text.agent` / `aside` / `delegate.card` / `notice.system`

不在白名单的 kind 只进轨迹。白名单写在注册表一处，**不许散在组件的 if 里**。

### 3.3 轮（turn）

`turn` = prompt atom + 属于它的消息 + 收尾状态。`turns` 表不再存 prompt 正文副本，改存 prompt 的
atom id（现在那份副本正是「一个键两个来源」）。

### 3.4 会话（session）

`session(1) → turn(N) → message(N) → block(N) → atom(N)`，另有跨层引用边（见 §6）。

## 4. 消息类型（枚举，覆盖现有 14 个）

对话类（chat=true）

| kind | 来源（现状） | 合并 |
|---|---|---|
| `text.user` | `messages.role=user,kind=text` | none |
| `text.agent` | `messages.role=player,kind=text` | stream |
| `aside` | `messages.kind=aside` | none |
| `delegate.card` | `messages.kind=delegate` | none |
| `notice.system` | `messages.role=system` | none |

过程类（chat=false）

| kind | 来源（现状） | 合并 |
|---|---|---|
| `thought` | `session_events.kind=thought` | stream |
| `tool_call` / `tool_call_update` | 同 | tool |
| `permission` / `permission_decision` | 同 | request |
| `usage` | 同 | none |
| `commands` | 同（16 条已知脏数据保留） | none |
| `delegate.request` | `session_events.kind=delegate` | none |
| `delegate.result` | `session_events.kind=delegate_result` | none |

流式碎片与最终正文是同一个 kind（`text.agent`）的两个阶段，由 `merge=stream` 区分，不新增 kind。

## 5. 关系清单

| 关系 | 基数 | 靠什么表达 |
|---|---|---|
| 会话 → 轮 | 1:N | `atom.turn_id` |
| 轮 → 消息 | 1:N | 同上 |
| 消息 → 块 | 1:N | `refs.messageId` + 合并规约 |
| 工具调用 → 状态更新 | 1:N | `refs.toolCallId` |
| 权限请求 → 裁决 | 1:1 | `refs.requestId` |
| 插话 → 那一轮 | N:1 | `refs.messageId`（归因）+ `seq`（位置） |
| 派活卡片 → 请求/结果 | 1:1:1 | `refs.handleId` |
| 派活 → 子会话 | 1:1 | `refs.childSession` |
| 通知 → 引发它的 atom | N:1 | `refs.parentAtomId` |

## 6. 扩展准入：怎么加新东西而不改结构

| 想加什么 | 做法 | 需要改结构吗 |
|---|---|---|
| agent 多发一个过程类信息 | 注册新 kind（chat=false，merge=none），渲染走通用条目 | 否 |
| 给某个 kind 加一个可选属性 | `payload` 加可选字段 + `schema` 次版本 +1 | 否 |
| 一次性/实验性数据 | `ext.x.<domain>.<name>` | 否 |
| 新关系（如「这条消息引用了某文件」） | `refs.fileId` + §5 登记 | 否 |
| 新块合并方式 | 注册表加 `merge` 取值 | 否 |
| 聊天区要显示新形态 | 新 kind + chat=true + renderer | 否 |
| 改变某 kind 的语义/删字段 | 升 `schema` 主版本或换 kind，保留旧读法 | 是（预期内） |

红线：`ext` 不许成为第二套语义；某键一旦影响显示或判定，就必须升级成 `payload` 的一级字段。

## 7. 与现状的差距

```
1  messages 无 turn_id           正文归不了轮，「上一轮」靠时间算
2  text 不进 session_events      正文不是 atom，「单一权威」不成立
3  kind 无枚举（14 个自由串）     拼错一个字符就是新的静默分支
4  delegate 两份                  卡片在 messages、过程在 events，权威未定
5  aside 无过程记录               插在哪一轮只活在运行时
6  turns 第三态语义重叠           cancelled 与 stop_reason='cancelled' 并存
7  seq 只按整会话单调             块内 chunk 顺序没依据
```

## 8. 口径（先定死，不等迁移）

- **权威 = atom**。`messages` 现在是「kind 白名单 + 渲染投影」的角色；在 M2 之前它临时兼任
  `text` 的权威，这是已知债，不再往上叠新债（不许再往 `messages` 加新 kind）。
- 新增任何消息形式，只能走 kind 注册表；不许再开第三张表或第三个字段约定。
- 任何展示路径都必须能回答「这条数据来自哪条 atom」——答不上来的展示就是错的。

## 9. 迁移档位

| 档 | 内容 | 代价 | 关掉的缺口 |
|---|---|---|---|
| **M0**（本文） | 模型、kind 枚举（Rust enum + ts-rs 导出）、注册表、块合并纯函数 | 1 张卡，零迁移 | 3 |
| **M1** | `messages.turn_id`（老数据可空）+ `refs` 规范化 + `kind` CHECK 约束 | 1 张卡 + 一次迁移 | 1 / 3 / 6 |
| **M2** | `atoms` 为唯一写入点，`messages` 与轨迹都成视图；历史搬迁、重放去重语义重定 | 全量回归，不可分批 | 1–7 |

判据：M2 只在出现**第三处**「同一逻辑事件写两份」时启动；现在只有 `delegate` 一处，不足以为它付 M2 的代价。

## 10. M1 实施要点（先定，再写代码）

### 10.1 轮的身份只有一个来源：后端

现状：后端在 `session_prompt` 里生成 `turn-<ms>` 并写进 `turns.id`，前端同时自造一个
`turn-live-<ms>` 挂在 UI 状态上 —— 两个 id 永不相等，于是轨迹面板的「轮」与消息永远对不上。

规则：

- `turnId` **由后端生成**，`session_prompt` 的返回值必须带上它。
- 前端只把返回值写回 UI 状态（先占位、收到回执后替换），**不许再自造 turn id**。
- 任何地方要「这条消息属于哪一轮」，只能引用这个 id。

### 10.2 `messages.turn_id` 的写入规则（四级，兜底明确）

```
① 调用方显式给的 turn_id（前端拿到后端返回的真 id）
② 没给 → 该会话当前 status='running' 的轮（最近一条）
③ 显式声明 nonTurn=true → 允许 NULL（握手期提示、发送失败、非轮次通知）
④ 都不满足 → 报 MissingTurnId，整批不落库（先解析后写入，不留半批）
```

为什么③要显式：静默落 NULL 会让「真该有轮却没轮到」变成查不出来的数据 —— 库里有行、界面正常、
事后无从对账。`nonTurn` 是调用方的一句断言，不是兜底。
列可空、加索引；老数据留 NULL，不做猜测性回填 —— 按时间反推「这条属于哪轮」正是要消灭的错。
前端所有 `messagesAppend` 调用点必须表态（带 turnId 或 `nonTurn: true`），由
`src/lib/append-sites.test.ts` 扫源码钉住。

### 10.3 kind 约束用触发器，不用 CHECK

SQLite **不能** `ALTER TABLE ... ADD CHECK`：只能重建表（关外键、搬全表、失败回滚整表）。
收益与触发器相同，风险高一个量级。

- 启动时 `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER`（`BEFORE INSERT` / `BEFORE UPDATE`），
  词典来自 Rust 常量（`messages.kind` 目前只写 `text` / `aside` / `delegate` 三个**旧词**，
  点号形式是 atom 层的名字，换名属于 M2 的搬表工作）。
- 词典一旦改动，触发器随之重建，因此不存在漂移。
- `CHECK` 约束留到 M2 搬表时一并落库。

### 10.4 `turns` 第三态只留一种说法

`status ∈ {running, finished, failed}`；**取消 = `status='finished'` + `stop_reason='cancelled'`**。
不再出现 `status='cancelled'`。迁移：`status='cancelled'` → `'finished'`，其中 `stop_reason` 为空的补 `'cancelled'`。

### 10.5 `refs` 规范化在 M1 只收口读取

`payload_json` 里游离的 `toolCallId` / `requestId` / `handleId` 由一个 `refs_of(payload)` 统一取，
不改列、不改数据；落列随 M2 搬表一起做。

### 10.6 回滚

M1 的迁移只有三种动作：加列（可留）、`UPDATE turns`（可逆）、触发器（可 DROP）。
迁移前自动备份整库（沿用 `db` 里既有的备份机制），旧二进制读到多出的列与触发器不受影响。

## 11. 正文与轨迹的分工（M1 收口，2026-10-26 定的）

结论一句话：**轨迹面板只讲过程，不显示正文；正文只在聊天区。两者靠锚点互相找到。**

### 11.1 语义边界

| 区域 | 显示什么 | 不显示什么 |
|---|---|---|
| 聊天区 | 正文（user / agent）、插话、派活卡片、系统提示 | 思考、工具调用、权限、用量 |
| 轨迹面板 | 轮 + 每轮做了什么（思考 / 工具 / 权限 / 派活 / 停止原因） | **正文**（哪怕本轮有正文，也不抄一份进来） |

理由：同一份正文在两处渲染，必然出现「一处更新一处没更新」；轨迹的价值是「过程与因果」，
不是「再读一遍回答」。

### 11.2 双向定位（互找的约定）

```
轨迹面板 · 每轮头部  「定位到正文」 → 聊天区滚到该轮第一条消息，短暂高亮（约 1.2s）
                    该轮没有可定位的正文 → 按钮禁用，并说明原因：
                      · 老数据（M1 之前写入，turn_id 为 NULL）：「这一轮没有记录正文归属」
                      · 轮内确实没有正文（只有过程）：「这一轮没有正文」
聊天区 · 每条消息    「在轨迹里看这一轮」 → 打开轨迹面板并滚到该轮
                    turn_id 为 NULL 的消息 → 不给这个入口（没有轮可就位，不猜）
```

判定依据都来自 `messages.turn_id` 与轮的 id 相等，**不做任何时间推断**（`src/lib/turn-align.ts`
的 `alignToTurns` / `unassigned` / `orphaned` 三个桶就是这件事的纯函数形态）。

### 11.3 老数据（146 条 turn_id 为 NULL）怎么呈现

**不插入「未分轮」分组标题，也不并进任何一轮。** 聊天区保持平铺（那里本来就是按 seq 读下来的
完整对话，没有轮也不影响阅读），只在「从轨迹跳过来」这一侧给出可解释的结果：没有归属就说没有归属，
不给假入口、不按时间就近归轮。

判据：任何「这条属于哪一轮」的界面结论，都必须能回指一条 `messages.turn_id`；指不出来就不要显示。
