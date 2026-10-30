# agent 自发起的轮：机制与排查（§32 的实现案卷）

> 这份文档是给**以后出问题时的自己**看的：机制在哪、判据是什么、日志怎么读、怎么临时关掉。
> 规范条文在 `docs/desktop-ux.md` §32，这里只讲实现与排查。

## 1. 为什么需要它

ACP 里只有「客户端发 `session/prompt`」这一种轮次起点。agent 被后台任务、定时器、内部通知唤醒后
继续干活时，服务端只是推 `session/update` —— **没有 `promptStarted`，也没有 `promptResult`**。

客户端如果只认客户端发起的轮，就会把这一整轮内容当成 `session/load` 的历史重放丢掉：
文字不显示、进行中不归零、通知不触发（通知的触发点正是 `promptResult`）。

实测过一次：367 个 `session/update` 全部被丢弃，界面零反应。

## 2. 机制一图

```
ACP 事件泵（每条事件）
  │
  ├─ 正文合批 emit_text ─┐
  └─ 其余 update ────────┴→ forward_session_update(UpdateRoute)
                              │
                              ├─ client_pending || load_pending || load 抑制窗口?
                              │     → 原样转发，状态机不介入（客户端轮行为不变）
                              │
                              └─ AgentTurns::on_session_update
                                    ├─ 没有合成轮 → 合成 PromptStarted(origin=agent)
                                    │               + db.start_turn() 建 turns 行
                                    ├─ 已有合成轮 → 刷新 generation / 维护 pending_tools
                                    └─ 每次都 spawn 一个 8s 定时器（旧定时器靠 generation 自杀）

定时器醒来 → AgentTurns::finish_if_idle(sid, generation)
   generation 未变 && pending_tools 为空 && pending_perms 为空
     → db.end_turn() + 合成 PromptResult(stopReason=end_turn, origin=agent)
```

## 3. 代码位置

| 关注点 | 位置 |
| --- | --- |
| 状态机（纯逻辑，可单测） | `src-tauri/src/state.rs` → `AgentTurns`、`SynthTurn`、`should_synthesize_start/end`、`apply_tool_update` |
| 唯一出口 | `src-tauri/src/commands.rs` → `forward_session_update(UpdateRoute)`、`emit_text` |
| 定时器 | `src-tauri/src/commands.rs` → `spawn_agent_turn_timer(SynthTarget)` |
| 常量 | `AGENT_TURN_IDLE_MS`、`LOAD_SETTLE_SUPPRESS_MS`（都在 `state.rs`） |
| 事件字段 | `AcpEvent::PromptStarted/PromptResult` 的 `origin`（`"client"` / `"agent"`；真实轮不序列化该字段） |
| 前端解析 | `src/hooks/useAcpEvents.ts`（`origin` 只用于诊断，不改变分支） |

## 4. 判据（改之前先看懂这三条为什么存在）

| 判据 | 防的是什么 |
| --- | --- |
| `pending_tools` 为空才收尾 | 长工具调用（`cargo test` 跑 60s）期间没有事件，否则会被提前判结束 |
| `pending_perms` 为空才收尾 | 等授权期间 agent 完全阻塞（Hermes 默认 300s 超时），否则会提前判结束 |
| `generation` 未变才收尾 | 定时器是每次事件新起一个，旧定时器必须能识别自己已过期，否则乱收尾 |
| `load_pending` + `LOAD_SETTLE_SUPPRESS_MS` | `session/load` 的重放（响应回来后残余的也在内）不能被当自发起轮，否则历史正文再说一遍 |

## 5. 排查：症状 → 查什么

| 症状 | 先看 | 常见结论 |
| --- | --- | --- |
| 唤醒后界面还是没反应 | 日志有无 `TURN-SYNTH-START` | 没有 → 状态机没进来：可能 `client_pending` 卡住（上一轮没落终态）或 `load_pending` 没释放 |
| 内容显示了，但一轮永远不收尾 | 有无 `TURN-SYNTH-END` | 没有 → 定时器被 `pending_tools`/`pending_perms` 挡住（看是否有工具调用从未 `completed`），或 `generation` 一直变（事件不停） |
| 一轮被提前切断，后半段另起一轮 | `TURN-SYNTH-END` 的 `reason` | `idle` → 8s 内没有事件且无 pending 工作；纯思考超过 8s 就会走到这（可调大 `AGENT_TURN_IDLE_MS`） |
| 打开历史会话后历史正文重来一遍 | `TURN-SYNTH-START` 出现时刻 | 与 `session/load` 时间重叠 → `LOAD_SETTLE_SUPPRESS_MS` 不够，或 `load_end` 没被调用 |
| 历史里轮次散架 / 消息 turn_id 悬空 | `TURN-SYNTH-START 落库失败` 告警 | `db.start_turn` 失败（多为 `ui_session_id` 缺失，见下） |

`ui_session_id` 缺失时**不建 turns 行**（只记告警）：消息会以「无归属」落库，
这时的表现是轨迹面板对不上，但聊天正文不受影响。这属于**已知缺口**，不是崩溃。

## 6. 已知缺口（不是 bug，别当回归查）

1. 合成轮在轨迹面板没有独立卡片：`session.turns` 只由发送流程 append；
2. 合成轮的轨迹事件仍按「无活动轮次」丢弃：`state.turns`（Turns 归属）只在 `sessionPrompt` 里建立。

### 6.1 界面没有「思考中」（2026-10-30 报，已定位、待修）

**表现**：agent 从后台任务被唤醒后，正文能正常流出来，但**没有那一行「思考中」**，显得文字是突然冒出来的。

**根因不在协议侧，在 UI 的活动行**。聊天区那一行「思考中」来自 `state.acts` 里 `status === "running"` 的活动行
（`App.tsx` 的 `ThinkingRow` 渲染处），而活动行**只有一个创建点**：

```
src/hooks/usePrompt.ts   ← 用户点发送时创建：id = `act-stream-${acpSid}`，kind=thinking，status=running
```

合成轮不经过 `usePrompt`（它是 Rust 侧凭 `session/update` 合成的），所以：

```
合成 PromptStarted(origin=agent) → turnId 记上、chunk 过了闸（正文正常）
                                ✗ acts 里没有那一行 → 没有「思考中」
                                ✗ busy 也没置真     → 界面不认为在跑
```

**修法很轻，因为收尾已经对上了**：活动行 id 是约定死的 `act-stream-${acpSid}`，
`promptResult` 的收尾逻辑正是按这个 id 找行（`useAcpEvents.ts` 的 promptResult 分支）。
所以只缺「开一行」，收尾一行都不用改：

```
promptStarted(origin="agent")
  ├─ 已有该 id 且 running → 不动（幂等，别重置 at，否则「已跑时长」每次事件归零）
  └─ 没有 → 插入 act-stream-${acpSid}（playerId=MAIN_AGENT_ID, kind=thinking, status=running）
  └─ busy = true
promptResult → 现有逻辑按同一 id 收尾（ok / error / stopped）
```

判定抽成纯函数 `ensureRunningAct(acts, actId, at)` 并单测（已有 running 不重置时间戳、没有才插、id 不匹配不误伤），
`useAcpEvents` 只负责在合成轮的 `promptStarted` 分支里调它。

**状态：已补**（分支 `fix/agent-turn-thinking`）。落点三处：

- `src/lib/turn-act.ts` —— `ensureRunningAct()`（幂等：已有 running 行走原样返回同一引用，不重置 `at`）
  与 `streamActId()`（活动行 id 的唯一口径）；
- `src/hooks/useAcpEvents.ts` 的 `promptStarted` 分支 —— `origin === "agent"` 时补活动行并 `busy = true`；
- 单测 `src/lib/turn-act.test.ts`（5 条：插入 / 幂等不重置时间戳 / 上一轮同 id 已收尾要替换 / 群聊不误伤别的行 / id 口径）。

真机验法：让 agent 从后台被唤醒，正文之前应当先出现「思考中」那一行；
若仍然直接出字，先看 `promptStarted` 到底有没有带 `origin=agent`（没带就是 Rust 合成那一侧没走到）。

### 6.2 假轮：`session/new` 之后与终态之后的错序（2026-10-30 实测）

§6.1 修的是「合成轮没有活动行」；同一个状态机还有相反方向的毛病：**它把不是轮的东西当成了轮**。
两条实证（本机日志 + 本地库；时间戳即为源码路径上可直接复核的现场）：

```
10:16:51.302712  session created
10:16:51.302955  forward -> webview kind=notification:session/update   ← session/new 后的首条通知，不落任何原子
10:16:51.302979  TURN-SYNTH-START turn-agent-…-29
10:16:51.309110  prompt sent
10:16:51.309714  TURN-SYNTH-END reason=client-takeover                 ← 真轮接手，发出 promptResult(origin=agent)
10:16:51.309797  forward -> webview kind=promptStarted
```

前端 `promptResult` 收尾不看 `origin`，于是刚建好的 `act-stream-<acpSid>` 被这条**让位结果**关掉 ——
用户看到的就是「新建会话发首条消息没有思考中」。

第二条代价更高：

```
10:17:14.464  prompt finished
10:17:14.489  TURN-SYNTH-START turn-agent-…-30
10:17:22.506  TURN-SYNTH-END … reason=idle
```

终态之后 25ms 到达的尾巴 update 开了新轮。本地库 `turn-agent-*` 名下挂着 **38 条 `text.agent`**：
回答被记到假轮上，`turn-*`（问题）与 `turn-agent-*`（回答）分家 —— 轨迹面板里问答不在同一轮。
同一份日志的 76 个合成轮里有 **22 个**是在 `prompt finished` 后 2 秒内起头的。

**判据**：一个「轮」必须由**内容**开张，且不能紧贴上一个真轮的终态。

修法三处，缺一不可：

1. **开轮白名单**（`state.rs`）：只有 `agent_message_chunk` / `agent_thought_chunk` / `tool_call` /
   `tool_call_update` 允许开轮；`session_info_update` / `available_commands_update` /
   `current_mode_update` / `usage_update` 是通知，不是轮。→ 挡住 `session/new` 那条。
2. **终态后抑制窗**（`state.rs`）：`client_end` 之后 `suppress_until = now + 1~2s`，窗口内
   `on_session_update` 只转发、不开轮。→ 挡住尾巴假轮与 38 条错位回答。
   **坑**：`client_end` 现有收尾在 `synth.is_none() && pending_perms.is_empty()` 时会把整条记录从 map
   删掉，删了就等于没设窗 —— 必须改删除条件（窗口未过期就不许删）。
3. **前端保底**（`useAcpEvents.ts`）：`promptResult(origin=agent)` 在 `sendTraces[acpSid]` 还在飞时
   **不得**关活动行、**不得**清 `busy` —— 让位结果不是真轮的终态。

单测：白名单逐 kind 断言；抑制窗（终态后 500ms 的 chunk 不开轮、窗口过后开轮）；前端在飞时不收行。
冷静期常量必须有名字（不许裸数字），与 `LOAD_SETTLE_SUPPRESS_MS` 并列在 `state.rs`。

验收（真机 + 库）：新建会话发首条消息能看到「思考中」；答完之后不许再冒出思考行；
库里新回答的 `turn_id` 必须等于对应问题的 `turn_id`。

## 7. 出问题时的最快止血

按代价从小到大：

1. **放大静默阈值**：把 `AGENT_TURN_IDLE_MS` 从 8_000 调到 30_000，能消掉「提前切断」，代价是收尾与通知变慢；
2. **关掉合成**：在 `forward_session_update` 开头直接返回（等价回到改造前）；
3. **整块回退**：`git revert` 这次提交；合成轮只存在于 Rust 侧，前端除了 `origin` 解析没有依赖。

## 8. 验收要点（真机）

1. 挂后台任务 → 唤醒后界面**立刻**进生成态、正文正常；
2. 该轮结束：生成态退出 + 计时收尾 + 通知（需 §31 已合）；
3. 长工具调用（>8s）与等授权（>8s）**不得**被判结束；
4. 打开历史会话（`session/load`）**不得**多出轮次、历史不得重放。
