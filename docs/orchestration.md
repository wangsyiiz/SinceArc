# 编排原语（delegate / wait）

> 状态：E13.4 第一批（delegate + wait）的合同。第二批（interrupt / active steering）不在本文范围。
> 上下游：`docs/architecture.md`（id 所有权与事件归属）、`docs/acp-notes.md`（审批两闸）、
> `docs/desktop-ux.md`（不是横幅、不染警示色的那几条视觉红线）。

## 1. 为什么在客户端

ACP 没有原生 subagent、也没有 active steering（T3 Code 的 `orchestrator-mcp-server.md` 结论同此）。
想在 ACP 上做多 agent，**编排只能落在客户端**：会话是我们建的、事件是我们路由的、结果是我们落库的。
所以这里的原语是「客户端拥有的子任务」，不是让两个 agent 互相说话。

**不做**（每一件都要有人长期维护它对不对）：

- 不做调度器（没有队列、没有优先级、没有重试编排）；
- 不开放给外部 agent 调用（那要 MCP 端点，另开卡）；
- agent 不能自己触发 delegate（v1 只有界面入口）；
- interrupt / steering 属第二批。

## 2. 原语

```rust
delegate(target, task, parent_ui_session) -> DelegateHandle
wait(handle, timeout_ms) -> DelegateOutcome
```

- `target`：群里一个成员（`agent_users.id`）——它带着自己的 profile 与 ACP 会话；也可以显式给 profile。
- `task`：任务描述正文。**只带任务描述**这一档的全部上下文就是它，所以文案要能自洽（能独立读懂）。
- 返回值（`DelegateHandle`）：

```rust
struct DelegateHandle {
    id: String,              // 客户端生成的句柄 id
    child_acp_session: String,
    target_member: Option<String>,
    context: ContextMode,    // member_fork | task_only
    reason: ContextReason,   // fork | fork_unsupported | fork_failed | caps_unknown | member_missing
}
```

`DelegateOutcome`：`{ status: running | finished | failed | timed_out, summary: Option<String>, elapsed_ms, stop_reason }`。

## 3. 上下文档位：fork 优先，回落 new，但**降级必须可见**

事实：真机 hermes 的 `sessionCapabilities.fork` 为真（`sessionFork: true`），ACP 1.12 里 `session/fork`
是协议原生方法（`{sessionId, cwd, additionalDirectories, mcpServers}`）；有的 agent 不报，就只能 `session/new`。

**fork 的是「成员自己的常驻会话」，不是发起派活的那条会话**（2026-10-25 定，否定「fork 父会话」）：

`session/fork` 只认**发起这条请求的那条连接自己创建过的会话** —— 请求是发给目标成员的连接的，
拿父会话 id 去 fork，对方进程根本不认识这个 id，跨 agent 必然失败。而成员的定义就是
「(连接, 固定 ACP 会话)」，所以派活的上下文只有两档：

- `fork` 可用且成员有自己的常驻会话 → `session/fork(member.acp_session_id)`：
  子任务接着 TA 自己的历史，`context = member_fork`，`reason = fork`。
- 不报 `fork` → `session/new` + 只发任务描述：`context = task_only`，`reason = fork_unsupported`。
- 报了 `fork` 但这次失败（JSON-RPC 错误）→ 回落 `session/new`：`context = task_only`，`reason = fork_failed`。
- 从没握过手（caps 快照缺失或已作废）→ **不算支持**：`task_only`，`reason = caps_unknown`。
- caps 说支持、但成员**没有**可 fork 的常驻会话（`agent_users.acp_session_id` 为空 / 反查不到）→
  `task_only`，`reason = member_missing`。
  这一档必须与 `fork_failed` 分开：fork 压根没发出去，说成「失败」会让用户以为 agent 拒过一次。

**「fork 父会话 / 继承用户这条对话」已否掉**：它既跨 agent 必失败，又把「成员的上下文」换成「用户的上下文」，
违反派活语义 —— 用户要的是「让 X 带着 TA 自己的理解去做」，不是「让 X 读我的这一轮」。

判据写死三条：

1. **档位由后端回报，前端不许自己推** —— caps 是握手快照，会因改命令而作废；`fork_failed` 只有后端知道。
2. **`fork_unsupported` 与 `fork_failed` 必须分开说** —— 前者是「这个 agent 就是没有这能力」，
   后者是「这次失败」。混成一句会让用户把环境故障读成 agent 能力缺失。
3. **caps 缺失不等于支持**：宁可说「只带任务描述」，不许按名字猜一份能力（与 E13.2 同一条规矩）。

### 三处落点（降级不是错误，是能力档）

| 时机 | 落点 | 内容 |
| --- | --- | --- |
| 派之前 | 派活菜单每一行 | 「带 TA 的上下文（fork TA 的会话）」/「只带任务描述（new）」，数据直接读 `caps.session_fork` |
| 派之后 | 父会话结果摘要 + 轨迹支线 | `member_fork` 不写额外说明（正常态不装饰）；`task_only` 写「没有带上下文：<原因>」 |
| 失败时 | 该菜单条目 / 结果摘要 | 连不上 → 条目禁用 + 写原因；`fork_failed` → 「fork 失败（原因），已按只带任务描述重跑」 |

**能力未知时懒握手**：打开派活菜单时，对还没连上的 profile 走一次 `ensureConnected`（带可见进行中），
连上后按真实 caps 显示档位。这不额外加成本 —— delegate 本来就必须连着才能做，早连一步而已。

**不染警示色**：`只带任务描述` 用 `ink-3` 陈述，它不是错误状态（`danger-1` 只留给数据损坏与破坏性操作）。

## 4. 子会话的归属

子 ACP 会话不是新的界面会话（侧栏里不该多出一行）。它注册进 `AppState.routes`：

```
profile_id      = 目标成员的 profile
cwd             = 目标成员会话的 cwd
ui_session_id   = 父界面会话        ← 事件投给父会话
author_id       = 目标成员 agent_users.id  ← 轨迹里是那个人的支线
```

于是子任务的事件（thought / tool_call / 最终回答）自然落进父会话的轨迹支线，最终回答以「被派活的人」
署名回到父会话 —— 这就是「谁派的、等谁、结果回哪」的答案，不需要另造一套展示。

## 5. 轨迹事件

新增两种 `session_events.kind`（同步加进 `KNOWN_EVENT_KINDS`）：

```jsonc
// delegate：派出去的那一刻
{"handleId":"dlg-…","target":"<agent_users.id>","targetName":"<显示名>","task":"<首 200 字>",
 "context":"task_only","reason":"fork_unsupported","parentAcpSession":"<父 ACP 会话>"}

// delegate_result：结束（完成/失败/超时各一条）
{"handleId":"dlg-…","status":"finished","summary":"<首 200 字>","elapsedMs":8123,"stopReason":"end_turn"}
```

派活时父会话没有活动轮次（常态：用户点「派活给…」时父会话是闲的）就**为这次派活开一轮**：
`turn.prompt = "→ <目标>：<任务前 200 字>"`，`author_id = None`（用户发起）。这一轮由派活方收
（子任务终态时 `end_turn`）；父会话已有活动轮次时挂上去，且**不替别人收轮**。不开轮就没有轨迹，
而「能看到谁派的」正是这张卡的验收项。

**子任务的那一轮走同一套 prompt 事件**：`acp.prompt.started` / `acp.prompt.result|failed`，
`session_id` = 子会话、`ui_session_id` = 父会话、`author_id` = 目标成员。
不发这一对会怎样：前端的重放守卫只收 `awaiting` 里的会话的 chunk，于是子任务的正文既不上屏、
也不落库 —— 用户看到「派活成功了」，却不知道被派的人说了什么。

**事件写完要敲一次轨迹**（wire topic `session.trace`）：前端只在 `busy` / `pendingPerm` 变化时重读轨迹，
而派活的开始与结束都不改这两个。不敲的话轨迹里那一步要等下一轮才出现，验收要求是立刻可见。

两条都挂父会话那一轮的 `turn_id`；`author_id` 写**派活的人**（父会话这一轮是谁发起的），
因为它记录的是「谁派的活」，不是「谁干的活」——后者看返回结果那条消息的署名。

## 6. 边界

- **深度 ≤ 1**：子任务不能再 delegate（返回 `50702`）。没有调度器时递归既烧 token 又说不清谁在等谁。
- **同父会话最多 3 个在飞**（返回 `50703`）：超了让人等，不是排队。
- **`wait` 超时不取消**：返回 `timed_out` + 仍在跑的事实。取消是不可逆动作，`interrupt` 是第二批。
- **不跨 profile 去替用户连接**：目标 profile 未连接 → `50300`「目标连接未连上」，让用户自己去连。

## 7. 错误码

| 码 | 含义 |
| --- | --- |
| 50700 | 目标不存在或不在本群 |
| 50701 | 任务正文为空 / 超长（> 8KB） |
| 50702 | 深度超限（子任务不能再派活） |
| 50703 | 同父会话在飞数超限（3） |
| 50704 | 句柄不存在（已结束或不是这个会话的） |
| 50300 | 目标 profile 未连接 |

## 8. 验收

单测（Rust）：

- caps 说支持且成员有自己的会话 → 走 `session/fork`（fork **成员的**会话），`context=member_fork`、`reason=fork`；
- caps 说支持但成员没有常驻会话 → `task_only` + `reason=member_missing`（不是 `fork_failed`）；
- caps 缺失 → 不调 fork，`task_only` + `reason=caps_unknown`；
- fork 返回 JSON-RPC 错误 → 回落 new，`task_only` + `reason=fork_failed`（与 unsupported 分开）；
- 深度 1 的子任务再 delegate → `50702`；第 4 个在飞 → `50703`；
- `wait` 超时 → `timed_out`，且**不**给目标发 cancel。

真机（两条都要跑）：

1. hermes（`sessionFork=true`）+ 一个有常驻会话的成员：派一个「列出当前目录下的 md 文件」→
   `member_fork`，且子会话的父是**成员那条**会话（不是派活的会话）；轨迹里出现目标成员支线，结果摘要回到父会话；
2. 假 agent（caps 全 false）：`task_only` + `fork_unsupported`，结果摘要写明「没有带上下文」；
3. 成员没绑 ACP 会话（或反查不到）→ `task_only` + `member_missing`，且**没有发出** `session/fork`（看日志）。
