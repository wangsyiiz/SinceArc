# 通信层与分层约定（Tauri IPC）

> 决定「前端怎么跟 Rust 说话、Rust 内部怎么分层」。这是性能与可维护性的地基，
> 也是「同样的 bug 不重犯」的落点之一：归属、顺序、丢事件、类型漂移都在这一层定死。

## 1. 现状与问题

现在的通信是「能用但没设计」：

- 每个连接（`agent_connect`）各自带一个 `Channel` → N 个连接 = N 个通道，前端要分别订阅、分别解包。
- 事件字段靠手写：`AcpEvent`（Rust）与 `AcpEvent`（TS）两份，改签名靠人记着同步 —— 本会话已经踩过漏同步。
- 业务代码里到处 `invoke("xxx")`：命令名是字符串，拼错只能运行时发现。
- 流式文本在**前端**按 40ms 合批；chunk 频率由 agent 决定，前端被迫做流控。
- 大payload（将来 GH 的 diff/文件列表）没有分页与体积约束，全量塞进事件就会卡界面。
- 排序/重放没有序列号：断线重连后无法判断「这条是新的还是旧的」。

## 2. 目标形态

```
              ┌──────────── Rust ────────────┐
 前端  ──命令──▶│ commands（薄编排 + 校验 + 错误码）│
      ◀─事件──│ services（domain：session/turn/member/gh）│
              │ adapters（acp 进程 / gh CLI）        │
              └──────────────────────────────┘
                       │
                 SQLite（唯一权威）
```

三条硬约定：

1. **一个事件通道**。应用启动时建一次 `Channel<WireEvent>`，所有域的事件都走它，
   用信封里的 `topic` 路由。连接数量不影响通道数量。
2. **一层类型契约**。Rust 的 DTO 是唯一来源，TS 类型**生成**（不手写）。
3. **业务代码不直接 `invoke`**。前端只通过 `src/lib/ipc/domains/*.ts` 的域函数说话。

## 3. 信封（WireEvent）

```ts
interface WireEvent {
  v: 1;                  // 契约版本，破坏性变更时 +1
  seq: number;           // 单调递增，用于判断乱序/丢事件
  ts: number;            // 毫秒时间戳（产生时刻，不是收到时刻）
  topic: string;         // 见下表
  sessionId?: string;    // ACP 会话（若与该事件相关）
  uiSessionId?: string;  // 投递给哪个界面会话（INV-1：缺就不投递）
  authorId?: string;     // 发言的群成员；主 agent 为 null
  lossless: boolean;     // 拥塞时是否允许丢弃
  payload: unknown;      // 具体域载荷（类型由 topic 决定）
}
```

`seq` 由后端全局递增；前端发现 `seq` 跳号时记 `EVENT-GAP` 并触发一次「重新读库」对账
（而不是相信内存）。

## 4. topic 表

| topic | 频率 | lossless | 说明 |
|---|---|---|---|
| `acp.text` | 高（流式） | 是（按段合并后） | 已合批的正文增量，后端每 30ms 或 4KB 发一次 |
| `acp.activity` | 中 | 是 | 工具调用/思考/写锁（E6 起由后端产出） |
| `acp.request` | 低 | 是 | 权限请求（带 `id`） |
| `acp.prompt` | 低 | 是 | `started` / `result` / `failed` 终态 |
| `acp.usage` | 中 | **否** | token/成本等可丢指标 |
| `conn.state` | 低 | 是 | 连接建立/断开/失败 |
| `gh.job` | 低 | 是 | GH 查询进度与完成（含分页游标） |
| `log.line` | 低 | 否 | 诊断日志（前端只保留最近 N 条） |

规则：

- **终端事件绝不丢**：`acp.prompt.result/failed` 丢了就等于「回答消失」。通道拥塞时先丢 `acp.usage`、`log.line`。
- **正文合批在 Rust 做**：`agent_message_chunk` 在 adapter 侧累积，达到 30ms 或 4KB 发一段；
  前端不再自己攒，只负责追加渲染。
- **大对象不进事件**：GH 的 diff/文件列表由 `gh.job` 给「可拉取的游标」，前端按需调命令取分页。

## 5. 命令契约

- 命名：`<域>_<动作>`（`session_prompt`、`agent_user_save`、`gh_pr_list`），域前缀固定。
- 入参：**必须显式**携带所属 UI 会话（`uiSessionId`）—— 见 INV-1。
- 返回：`Result<T, CmdError>`，`CmdError { code, msg }`，码段见 `architecture.md` §7。
- 前端：`src/lib/ipc/client.ts` 提供 `call<T>(domain, action, args)`，统一把
  `code` 映射成人话；域函数只做参数整理，不做业务判断。

## 6. 前端分层

```
src/lib/ipc/
  client.ts      —— 唯一的 invokeCmd 出口、错误归一、fireAndForget
  events.ts      —— 订阅单通道、按 profileId 分发、版本/seq/归属检查
  types.ts       —— DTO 形状（M5 起由 Rust 生成 types.gen.ts 取代）
  domains/
    acp.ts       —— 连接/会话/模式/权限/探测
    session.ts   —— 连接配置/会话行/消息
    member.ts    —— 成员/成员关系
    gh.ts        —— 仓库/PR/Issue（E9）
  index.ts       —— 门面；业务代码只 import `@/lib/ipc`
```

规则：`components/` 只 import 域函数与类型；**禁止**出现字符串命令名。

## 7. 数据模型（按域）

### ACP 域（`acp`）
`Profile`（连接配置）、`InitializeOutcome`（握手：agent 名/版本/协议/能力）、
`ModeSnapshot`、`AcpSession`（`acp_session_id` + profile + cwd，凭证，见 INV-9）。

### 会话域（`session`）
`Session`（UI 会话，唯一持久身份）、`SessionBinding`（历史：何时绑了哪个 acp 会话、原因）、
`Message`（`id/role/kind/payload`）、`Turn`（一轮：user 文本 → 终态）、
`Activity`（tool_call/thinking/写锁，**后端产出**）。

### 群域（`group`）
`AgentUser`（身份：profile + acp 会话 + 名字/handle/颜色）、`Membership`（群↔成员）。

### 轨迹域（`session_events` 视图 + 聚合视图）

> 存储变更（2026-10-26）：`session_events` 现在是 `atoms(channel='trace')` 上的同名视图；
> 正文侧 `messages` 同理是 `atoms(channel='chat')` 的视图。协议与字段不变，只有落点在 atoms。

**源数据必须落库，派生图不落库** —— 这是两件事，别混：

- `session_events`（append-only）：在事件发生的那一刻记下的原始活动 ——
  `kind`（thought / tool_call / tool_call_update / permission / usage / mode）、`turn_id`、
  `author_id`、`at`（发生时刻）、`payload_json`（结构化摘要 + 原始）、`source ∈ {live, replay}`。
- 轨迹图由后端**按需聚合**（`session_trace`），前端只渲染泳道。不存派生结果：
  存了就会与源数据不一致。

**和 agent 侧记录的分工**（实测：`session/load` 会重放整段历史，且带 tool_call）：

| | agent 侧 | 我们侧 |
|---|---|---|
| 定位 | 它的记忆，供自己续聊 | 用户的历史与审计 |
| 取法 | 只有 `session/load` 的重放副作用（ACP 无「读历史」RPC） | 直接查库 |
| 覆盖 | 单 agent、单会话 | 跨 agent、跨群、全局时间线 |
| 完整性 | 操作完整、**思考残缺**（实测两轮仅 1 条 thought） | 收到什么记什么 |
| 可用性 | 需要进程与会话都在 | 离线可读 |
| 时间戳 | 无（只有到达顺序） | 有（我们记的发生时刻） |

⇒ **我们记一份是主库，agent 那份当灾备/补录源**。

**保留与截断（已定）**：
- 单会话轨迹上限 **5 万条**、时间上限 **90 天**，超出**直接删除**（不归档）。
- 单条 `payload_json` 上限 **64KB**；思考片段只保留**前 8KB**，超限标记 `truncated`。
- **必须写在界面上**：轨迹面板常驻一句「思考过程只保留开头 8KB，轨迹保留 90 天，
  超出会自动清理」，截断条目本身带可见标记 —— 否则用户会把截断当成 bug
  （`design-language.md` §11）。

### GH 域（`gh`）
`Repo`、`PullRequest`、`Issue`、`CheckRun`、`FileDiff`（分页）、`Comment`。

## 8. GH 三层抽象

```
gh CLI（外部进程）
   ↓  adapter：执行、超时、JSON 解析、错误映射（未安装/未登录/限流）
domain service：规范化 → 校验 → 缓存（TTL）→ 分页游标 → 视图模型
   ↓  命令层：gh_repos_list / gh_pr_list / gh_pr_detail / gh_diff_page
前端：只渲染 + 翻页（纯视图状态）
```

必须遵守：

- **不为每种视图写一次命令**：命令按「资源 + 动作」设计，视图在前端组合。
- **分页永远在后端**：返回 `{ items, nextCursor }`，前端不一次性拿全量。
- **错误可分辨**：`gh` 未安装 / 未登录 / 限流 / 仓库不存在，各有码，前端只翻文案。
- **与 acp 域解耦**：GH 域不知道「会话」的存在；「把 PR 引用进对话」是前端把结构化数据交给
  `session_*` 命令，由后端校验后写入消息 `quoted` 字段。

## 9. 性能预算

| 场景 | 现状 | 目标 |
|---|---|---|
| 流式正文 | 前端 40ms 合批，chunk 频率不可控 | 后端 30ms/4KB 合批，单事件 ≤ 4KB |
| 多连接 | 每连接一条 Channel | 单通道 + topic 路由 |
| 长历史 | 一次 `messages_load` 默认 200 条 | 分页游标（`before=<seq>`），首屏 50 条 |
| GH 列表 | 未实现 | 分页 + TTL 缓存（列表 30s，详情 5min） |
| 事件量上限 | 无 | 单连接每秒 ≤ 200 事件；超出合并或丢弃非无损主题 |

## 9.5 进度

- **M1 实现完成**（待真机烟测）：`src-tauri/src/wire.rs` 提供全局 `EventBus` 与 `WireEvent` 信封；
  `ipc_subscribe` 在启动时订阅一次；`agent_connect` 不再接收 Channel；
  所有出站事件（notification/request/prompt\*/hello/exited）都带 `topic + seq + 归属`。
  前端 `lib/ipc.ts` 的 `onAgentEvent(profileId, fn)` 幂等订阅一次并分发；
  `seq` 跳号记 `EVENT-GAP`，版本不符记 `WIRE-VERSION`，无归属记 `DROP-NOPROFILE`。
- **M2 实现完成**：`src/lib/ipc/` 拆成 `client.ts`（唯一 `invokeCmd` 出口 + 错误归一 +
  `fireAndForget`）、`events.ts`（单通道订阅与分发）、`types.ts`（DTO 形状）、
  `domains/{acp,session,member}.ts`、`index.ts`（门面，业务代码只 import `@/lib/ipc`）。
  `lib/log.ts` 也改走 `fireAndForget`。新增守门用例 `ipc/layering.test.ts`：
  `invoke(` 只允许出现在 `client.ts` / `events.ts`（已验证「故意放一个违规文件 → 变红」）。
- **M3 实现完成**：正文合批搬到 Rust（`src-tauri/src/coalesce.rs`，30ms tick 或 ≥4KB 立刻发；
  换会话/换作者/收到非正文事件前先冲缓冲，保证顺序）。前端删掉自己的 40ms 定时器
  （`useAcpEvents` 直接落界面）。事件形状不变，前端无需区分「是否合并过」。
- **M4 实现完成**：`session_bindings`（历史）+ `sessions.acp_state`；绑定入口只有
  `session/new`（created）、验证成功的 `session/load`（loaded）、显式 `session_rebind`（replaced）。
  同 id 重复绑定幂等；换 id 归档旧绑定；`mark_acp_invalid` 只标状态、保留凭证，
  且只在 agent **明确拒绝**时触发（超时/断连不算凭证失效）。
- M5–M6 未开始。

## 10. 迁移路径（不许一次性大改）

1. **M1**：加 `WireEvent` 信封与单通道，现有的 `AcpEvent` 原样塞进 `payload`（行为不变）。
2. **M2**：前端 `src/lib/ipc/` 分层落地，业务代码改走域函数（机械替换，无行为变化）。
3. **M3**：正文合批搬到 Rust；前端删掉自己的 40ms 逻辑。
4. **M4**：`SessionBinding` 历史表 + 绑定校验（INV-9）。
5. **M5**：类型生成（ts-rs），删掉手写 DTO。
6. **M6**：GH 域按 §8 从零建（不走 acp 的旧路子）。

每一步都必须「行为不变 + 有测试」；M3 与 M4 会动到关键链路，单独排期。
