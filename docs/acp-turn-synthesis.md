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
