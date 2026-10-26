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

### 11.2 双向定位（互找的约定，2026-10-26 修订）

**入口只有一个，在 agent 消息上，常亮。** 不加 hover 才出现的按钮，也不给用户消息加入口 ——
用户发的消息不属于轨迹，给它一个「看轨迹」的入口等于承认它进过轨迹。

```
聊天区 · agent 消息   名字 | 时间 之后一个常亮小图标（Waypoints），点击 → 打开轨迹面板并滚到该轮
                     turn_id 为空 → 不显示（没有轮可就位，不猜）
聊天区 · 用户消息     没有入口（用户消息不进轨迹）
轨迹面板 · 每轮头     「定位到正文」：命中 → 聊天区滚到该轮首条并短暂高亮（约 1.2s）
                     未命中 → 按钮禁用 + 文字说明原因：
                       · 整条会话一条带 turn_id 的消息都没有：「这一轮没有记录正文归属（M1 之前的数据）」
                       · 否则：「这一轮没有正文」
```

**轨迹面板不显示用户原文。** 轮头写「第 N 轮 · 起止时刻 · 结局」，不抄用户发的那句话：
轨迹的语义是 agent 的思考与调用轨迹，与用户数据无关；用户说过什么在聊天区本来就有。

判定依据都来自 `messages.turn_id` 与轮的 id 相等，**不做任何时间推断**（`src/lib/turn-align.ts`
的 `alignToTurns` / `unassigned` / `orphaned` 三个桶就是这件事的纯函数形态）。

### 11.3 老数据（146 条 turn_id 为 NULL）怎么呈现

**不插入「未分轮」分组标题，也不并进任何一轮。** 聊天区保持平铺（那里本来就是按 seq 读下来的
完整对话，没有轮也不影响阅读），只在「从轨迹跳过来」这一侧给出可解释的结果：没有归属就说没有归属，
不给假入口、不按时间就近归轮。

判据：任何「这条属于哪一轮」的界面结论，都必须能回指一条 `messages.turn_id`；指不出来就不要显示。

## 12. 入库口径与开发期数据处置（2026-10-26 所有者定）

### 12.1 什么进库

入库存的是**用户最终应该保留的数据**：

```
一轮的正文      用户全文、agent 最终回答全文
轮的身份与结局  turn 的起止、stop_reason
关键事实        工具调用及其状态变更、权限请求与裁决、派活与结果、用量快照、命令列表快照
```

**流式分片（chunk）是协议层的临时传输数据，不进库。** 它只活在内存与界面里；一段流结束时
（换 `messageId` / 中间插入了别的原子事件 / 轮结束）才落一条完整 atom。

判据一句话：**同一条事实重复到达 N 次，库里仍然只有 1 行。** 按这条，现在的实现是错的 ——
`thought` 每 chunk 落一行（实测 6296 行、平均 27 字节），落进去的是传输节奏，不是事实。

### 12.2 粒度

```
正文   一段回答        = 1 atom（不是每 chunk 1 行）
思考   一段思考        = 1 atom（现在是每 chunk 1 行，要收敛）
工具   一次调用        = 1 atom；其后的状态变更各自 1 atom（状态变化是事实，不是分片）
权限   请求 + 裁决     = 各 1 atom
派活   请求 + 结果     = 各 1 atom
```

显示不变：正在发生的思考仍然逐字出现，只是不再落库。恢复历史会话时按块显示 —— 历史会话本来
也不是逐字重播的，这条差异在界面上不可见。

### 12.3 开发期的旧数据处置（发布后失效）

唯一判据：**按新结构重写时，是否会改变数据结构。**

```
会改   旧行在新结构里无法表达、或无法读 → 旧数据直接删除，不做兼容分支、不做回填、不做双表读
不改   旧行换个读法仍然成立           → 保留，正常读
```

**这条规范只适用于现在（未发布）**：一旦发布，一律走 §9 的编号迁移 + 兼容窗口，禁止删数据。

依此判据，M2 搬表时会被删除的是：

```
删   messages 现有 150 行      —— M2 后它不再是权威表（变视图），旧行在新结构里没有位置
删   session_events 6463 行    —— chunk 级 thought 在新口径下不合法（§12.1）
留   sessions / turns 骨架     —— 结构不变，会话列表与轮次仍要能读
```

### 12.4 产品优先

**功能定义不随模型改变；模型是服务功能的实现手段。** 任何「因为模型这样，所以功能得那样」
的提案都先回到功能：先说清用户要什么，再说模型怎么承载。反过来做，模型就会开始改写产品。

## 13. M2 实施要点（atoms 成为唯一权威，2026-10-26 开工）

### 13.1 结构：一张表 + 两个同名视图

```sql
-- 唯一写入点
CREATE TABLE atoms (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  channel      TEXT NOT NULL CHECK (channel IN ('chat', 'trace')),  -- 正文流 / 过程流
  turn_id      TEXT,                    -- 非轮次原子为 NULL（§10.2 四级口径）
  seq          INTEGER NOT NULL,        -- channel 内自增，两套空间互不干扰
  at           INTEGER NOT NULL,
  role         TEXT,                    -- chat：user / player / agent / system
  author_id    TEXT,                    -- trace：群成员 id；主 agent 为 NULL
  kind         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  refs_json    TEXT,                    -- 命名键 refs（childSession / parentAtomId…）
  ext_json     TEXT,                    -- x.<domain>.<name> 扩展键，未注册也原样保留
  source       TEXT NOT NULL DEFAULT 'live' CHECK (source IN ('live', 'replay')),
  truncated    INTEGER NOT NULL DEFAULT 0,
  sealed_at    INTEGER,                 -- NULL = 仍在流式归并中（见 13.3）
  UNIQUE (session_id, channel, seq)
);
CREATE INDEX idx_atoms_turn   ON atoms(session_id, turn_id);
CREATE INDEX idx_atoms_kind   ON atoms(session_id, kind);
CREATE UNIQUE INDEX idx_atoms_open
  ON atoms(session_id, turn_id, kind) WHERE sealed_at IS NULL;
```

```sql
-- 读路径零改动：旧名字变视图，列与旧表一一对应
CREATE VIEW messages AS SELECT id, session_id, turn_id, seq, role, kind,
       payload_json, at AS created_at, author_id FROM atoms WHERE channel = 'chat';
CREATE VIEW session_events AS SELECT id, session_id, turn_id, seq, at, author_id,
       kind, payload_json, source, truncated FROM atoms WHERE channel = 'trace';
```

为什么用视图而不是改所有查询：读路径有十几处（会话历史、轨迹、水位、去重），改一处漏一处的风险
远大于视图的查询开销；写入点只有两个（`append_messages` / `append_events`），改在那里就够了。

### 13.2 写入

- `append_messages` → 写 `atoms(channel='chat')`；轮次四级口径与 `ON CONFLICT(id) DO UPDATE` 语义不变。
- `append_events` → 写 `atoms(channel='trace')`；`seq` 从 `MAX(seq) FILTER channel='trace'` 自增。
- kind 守卫触发器从 `messages` 搬到 `atoms`（视图上不能挂触发器），条件 `channel = 'chat'`。
- `schema.sql` 同步：新库直接建 atoms + 视图，不再建两张表。

### 13.3 流式归并：一段流 = 一行（open → sealed）

```sql
-- 同一 (session, turn, kind) 允许有一行「未封口」的原子
-- 收到下一个分片 → UPDATE 该行 payload（受 8KB 上限约束），库里始终只有 1 行
-- 封口条件（任一）：
--   ① 出现不同 stream key 的痕迹事件（工具调用、权限、用量、命令列表…）
--   ② 该轮进入终态（finished / failed）
--   ③ 会话关闭 / 进程退出（下一次打开会话时把残留 open 行当作已封口）
```

没有基于时间的切块：切块只由「流的事实边界」决定，不由停顿长短决定。
正文同理：一段回答结束（换 messageId 或轮结束）才封口，中途只更新那一行。

界面不受影响：实时思考走 ACP 事件流推给前端，面板读到的是当前那一行（内容随分片增长）。

### 13.4 迁移与旧数据（按 §12.3）

```
M2-01  建 atoms 表 + 索引
M2-02  删旧表 messages / session_events（旧行在新结构里没有位置；开发期直接删，不迁移）
M2-03  建同名视图 messages / session_events
M2-04  kind 守卫触发器建到 atoms 上（channel='chat'）
M2-05  schema.sql 同步（新库直接是 atoms + 视图）
```

`sessions` / `turns` 骨架保留。旧数据删除前照例先备份一份到仓外。

### 13.5 验收

```
库      跑一轮长思考 + 一轮普通回答：
        · 该会话 channel='trace' 的 thought 行数 = 思考段数（不再是 chunk 数，预期从 1543 → 个位/十几）
        · 正文 channel='chat' 一行一段（不随分片增加）
        · 关掉应用重开，思考内容与条数与改前一致（read 侧 trace::aggregate 的合并逻辑仍成立）
界面    轨迹面板内容与改前一致（DOM 文本比对）；聊天区无变化
门禁    cargo / clippy / tsc / node --test / vite build 全绿
```

## 14. 扩展点落地（E16 收口复盘，2026-10-26）

模型 §1/§2 承诺了 `schema`、`refs`、`ext` 三个扩展点，M2 只把前两个建成了空列、`schema` 直接漏了。
本节把「结构上留位」补成「写入路径真的填」—— 扩展点不能只在建表语句里存在。

### 14.1 列

```sql
ALTER TABLE atoms ADD COLUMN schema INTEGER NOT NULL DEFAULT 1;   -- 迁移 M2-06
refs_json / ext_json 已有，本卡开始真写
```

### 14.2 写入

```
refs   trace 捕获时就地填（不靠调用方记得传）：
         tool_call / tool_call_update → {"toolCallId": …}
         permission / permission_decision → {"requestId": …}
         delegate / delegate.result → {"childSession": …}
         text.agent 流 → {"messageId": …}
       规则：refs 只放「定位键」，能用来把后续原子挂回同一个对象；
             放不进命名键结构的信息进 payload，不塞 refs。
ext    协议里 `x.<domain>.<name>` 形状的键原样收进 ext_json（未注册也留），渲染忽略。
schema 每个 kind 的 payload 版本，初始一律 1；改 payload 的可选字段 +1 次版本，
       改语义/删字段升主版本（旧读法保留）。
```

### 14.3 验收

```
写一条带 refs={"toolCallId":"c1"} 与 ext={"x.demo.a":1} 的 atom → 读回逐字一致
真库跑一轮带工具调用的对话 → SELECT refs_json FROM atoms WHERE kind='tool_call' 非空
                              SELECT count(*) FROM atoms WHERE refs_json IS NOT NULL > 0
界面不变（refs/ext 不参与渲染）
```

## 15. 流程守卫（E17 第一张卡，2026-10-26）

模型只保证「一个事实一个来源」，它管不住时序与生命周期 —— E16.7 那个「轮已终态却留着未封口行」
就是靠人工查库才发现的。本节把这类不变量写成断言，交给机器每次跑。

### 15.1 不变量（写成代码的地方见括号）

```
I1  open ⇔ 在跑       sealed_at IS NULL 的原子，其轮必须是 running / waiting_approval；
                      没有 turn_id 的原子必须已封口（启动自检 + 单测）
I2  终态即封口        轮进 finished / failed 后写入的原子一律 sealed_at 非空（状态机矩阵）
I3  一行一段流        同一 (session, turn, kind) 同时最多一行 open（唯一索引 + 状态机矩阵）
I4  视图映射穷尽      messages 视图 CASE 必须覆盖注册表里所有 chat kind，漏一个即红（静态守卫）
```

判定口径：出现了「不能解释的状态」就是 bug，不要用「大概是迟到事件」把它糊过去 ——
要么这条不变量本来就不对（那改规范），要么代码错了（那修代码）。

### 15.2 I1 的启动自检

`Db::open` 收尾时跑一次自检；命中就 `tracing::warn!` 带上 session / turn / atom id，
**不自动修复**（自动改数据会把「谁写坏的」这条线索一起抹掉）。查询：

```sql
SELECT a.id, a.session_id, a.turn_id, t.status
  FROM atoms a JOIN turns t ON t.id = a.turn_id
 WHERE a.sealed_at IS NULL AND t.status NOT IN ('running', 'waiting_approval');
```

自检只在启动时跑，不进热路径。

### 15.3 I4 的静态守卫

`db/schema.sql` 里 `messages` 视图的 `CASE kind WHEN …` 分支，与 `message_kind.rs` 的 chat kind
集合作逐项比对（手法同前端注册表镜像守卫）：少一个 → 该 kind 的 chat 原子会走 `ELSE` 被当成正文，
静默错类。测试直接读两个文件比对，不查库。

---

## 13. 轨迹补录与容量提示（2026-10-26 所有者拍板）

这一节替换掉 E10.3 卡上原来写的「超过阈值直接删除、不归档」。**所有者口径：只统计，不清理。**

### 13.1 补录（backfill）

- 命令 `session_trace_backfill(profileId, acpSessionId, uiSessionId)`：调 `session/load` 拿重放事件，把**轨迹类**原子
  （工具调用、状态变更、思考）落库，`source='replay'`。
- 适用场景只有一个：**本地缺这一段轨迹**（例如曾经断线、或这段是别处产生的会话）。它不是实时数据源 ——
  实时数据永远来自 live 事件。**不自动触发**，只有用户显式点「补录」才跑。
- 幂等：按「会话 + 事件身份」去重，重复补录不产生重复行；**不覆盖已有 live 行**（live 是事实的第一手来源）。
- 正文（chat 通道）不从 replay 落库：§12.1 的判据优先，重放只补轨迹。

#### 13.1.1 重放怎么捕获（实现口径）

- 现状是 `record_trace` 明确把「没有活动轮次」的事件丢掉 —— 重放正好没有活动轮次，所以现在的行为是**全丢**。
  补录要在 `AppState` 里加一个按 ACP 会话 id 的**捕获窗口**：`record_trace` 先看该 id 有没有捕获器，
  有就把事件推进内存缓冲并 return（不写库、不当 live）；窗口关闭后缓冲即丢。
- 窗口边界：发起 `session/load` 前开、`load` 响应后再静默 2 秒关；整体硬上限 120 秒（超时按已捕获的落库并回 `timedOut`）。
- 捕获期间 chat 正文照旧丢弃（不落库），所以补录不会改动正文行数。

#### 13.1.2 没有轮次怎么办：合成一条「补录轮」

轨迹按轮展示，而重放事件不带轮次。捕获非空时建**一条**合成轮：

```
turns.id          turn-replay-<uiSessionId>-<runStamp>
started_at/ended_at 捕获事件的 min(at) / max(at)
status            finished，stop_reason 用 end_turn
prompt / prompt_atom_id  空
```

`stop_reason` 必须用 `end_turn`：前端 `TracePanel` 把非 `end_turn` 的 stopReason 当异常渲染，用 `replay`
会显示成失败。provenance 不靠轮次表达，靠原子行：`source='replay'` + `ext` 里的 `{"x.replay": true}`。

原子 id 与去重**按批次**算（2026-10-26 真机修正）：

```
batch = FNV-1a 64(按捕获顺序拼起来的 "kind | payload_json" 序列)   // 16 位十六进制
轮 id  = "turn-replay-" + uiSessionId + "-" + batch
原子 id = "rp-" + batch + "-" + 序号
写入    INSERT ... ON CONFLICT(id) DO NOTHING
```

- **不能把 `at` 放进 id**：ACP 的 `session/update` 不带时间戳，`at` 只能取「捕获时刻」，
  同一段重放两次会得到两套不同的值 —— 真机上实测第二遍多写了 7 行（179→186→193），这就是错的。
- 批次是幂等的单位：同一次重放两次 → `batch` 相同 → 轮 id 相同 → **整批跳过**，
  返回 `{captured, added:0, skipped:captured}`，行数不变。
- 批次内用序号保序，所以同一批里两条内容完全相同的事件（例如两次同 payload 的状态更新）不会被压成一条。
- 已有 live 行即使撞 id 也不会被覆盖（DO NOTHING，不是 DO UPDATE）。
- 返回 `{ captured, added, skipped, timedOut }`，前端只把这些数说人话，不做二次判断。

#### 13.1.3 不做

- 不自动补录（不开后台任务、不在打开会话时偷偷跑）。
- 不从 replay 写正文、不合并到已有轮次里（宁可多一条「补录轮」，也不猜归属）。
- 不删任何行。


### 13.2 容量提示：只统计，不删除

- 阈值：单会话原子数 **> 50 000**，或最早原子 **> 90 天**。
- 后端只提供统计，`session_storage_stats(uiSessionId)` 返回
  `{ atomCount, chatCount, traceCount, bytes, oldestAt, thresholds: { count, days }, over, reasons }`。
  **它不删任何行**，也不写任何表。
- 前端在**消息流末尾**渲染一条提示气泡。它不是 atom、不进库、不写 `session_events`：
  重开会话时由重新统计产生，关闭状态只活在本进程内存里。
- 文案按 `design-language.md` §10（讲事实与后果 + 数值来源），例如：
  「本会话已积累 52,318 条轨迹，超过提示阈值 50,000 条。这些数据不会被自动删除。」
  —— 计数与阈值都来自 `session_storage_stats` 的返回，不在前端写死。
- **不做**：自动删除、归档、压缩、按年龄清理、一键清空。

### 13.3 为什么只提示（写清代价）

删除轨迹是不可逆操作。按所有者对不可逆操作的立场：**程序不替用户决定处置数据，必须显式授权**；
也不做「快照/宽限期/回收站」这类兜底。所以客户端能做的是把事实摆出来，处置权留给用户。

代价明写：库会随使用增长，5 万条 / 90 天只是**提示线**，不是硬上限，也不会自动回收空间。
真要提供清理入口，是**另一张卡**，且要求：预检清单可扩展（以后加检查项不改协议）+ 由用户显式确认。

### 13.4 验收（读数，不看形容词）

```
超阈值      构造 50 001 条 atom → 打开会话，气泡出现，计数与阈值与后端返回一致
不落库      气泡出现前后 atoms / session_events 行数不变；重启应用后气泡是重新统计出来的
未超阈值    无气泡
补录        补录一次轨迹完整、source='replay'；重复补录行数不变；live 行不被覆盖
无删除路径  代码里不存在按年龄/条数 DELETE 的语句（评审时搜索确认）
```
