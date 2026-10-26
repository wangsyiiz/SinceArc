# 权限请求应答规范

E3 的后半。范围：agent 发来的 `session/request_permission`，从进来到用户点完、我们回写为止。
不涉及本地持久化的「永久规则表」——那部分明确不做（见 §7）。

---

## 1. 协议事实（真机实测，`tests/permission_respond.rs` 是可执行版本）

agent 发来的请求：

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "session/request_permission",
  "params": {
    "sessionId": "local-<hash>",
    "toolCall": {
      "kind": "edit",
      "title": "Approve edit: /path/to/file",
      "toolCallId": "edit-approval-1",
      "status": "pending",
      "rawInput": { "tool": "write_file", "arguments": { "path": "...", "content": "..." } },
      "content": [ { "type": "diff", "path": "...", "newText": "..." } ]
    },
    "options": [
      { "kind": "allow_once",  "name": "Allow once", "optionId": "allow_once" },
      { "kind": "reject_once", "name": "Deny",       "optionId": "deny" }
    ]
  }
}
```

我们回的：

```json
{ "jsonrpc": "2.0", "id": 7, "result": { "outcome": { "outcome": "selected", "optionId": "allow_once" } } }
```

要判断的事实，逐条：

1. **选项由 agent 决定，不是固定三档**。hermes 在 `default` 模式下只给两项（`allow_once` / `reject_once`），
   没有 `allow_always`。界面必须按收到的 `options` 渲染，不能写死「一次 / 本项目 / 拒绝」。
2. **`kind` 只是 UI 提示**，取值 `allow_once | allow_always | reject_once | reject_always`。
   真正的语义键是 `optionId`，而且它**不一定等于** `kind`（实测拒绝项 `kind=reject_once` 但 `optionId="deny"`）。
   ⇒ 任何地方都不许把 `optionId` 硬编码成 `"reject"` 之类的字符串。
3. **回写之后这一轮继续跑**。实测：回 `allow_once` 后 `session/prompt` 正常返回 `stopReason: end_turn`。
4. **`cancelled` 只表示「用户中止了这一轮 prompt」**，不是「拒绝这次操作」。
   拒绝就是选一个 `reject_*` 选项。协议里没有超时概念；我们若超时自拒，也必须选 `reject_once`，不能回 `cancelled`。
5. **同一 `id` 只该被回答一次**。重复回答会让 agent 侧收到它不认的响应。

---

## 2. 队列：同会话按到达顺序，一次只显示一个

同一个会话里可能出现多个待答请求（一轮里连续改几个文件）。做法：

- Rust 侧登记表（`state::PendingRequests`）按 `profile_id` 存 id；
- 前端按 UI 会话存一个 FIFO 队列，**队头即界面上的那一个**；
- 标签页角标、输入框上方的提示、弹窗都读队头，所以它们天然一致。

为什么不并排显示：多个模态同时弹会把决定顺序搞乱，而 agent 是按顺序等的 —— 用户看的应该是
「下一步要答哪一个」，不是「有一堆弹窗」。

## 3. 应答必须一条一次（幂等由客户端保证）

`agent_respond_request` 先摘登记再写回：

- 不在册（已答过 / 本来不是我们发的 / 断连后清掉了）→ 直接报 `50500`，不往 agent 写任何东西；
- 写回失败 → **把登记还回去**，让用户能重试。写失败不等于答过了。

这条挡的是双击按钮、两个窗口同时点、以及界面状态过期这三种真实情况。

## 4. 取消与拒绝

| 用户动作 | 我们发什么 |
|---|---|
| 点 `Allow once` | `selected` + 该按钮的 `optionId` |
| 点 `Deny` | `selected` + 该按钮的 `optionId` |
| 按 Esc / 点弹窗外 | 找队头里第一个 `kind` 以 `reject` 开头的选项，发 `selected` + 它的 `optionId` |
| 队头里一个 reject 项都没有 | 才发 `{ "outcome": "cancelled" }` |

Esc 不等于「关掉弹窗不管」：不回答会让 agent 一直等到它自己超时，用户以为点掉了，实际那一轮还挂着。

### 4.1 没人能看见的请求，一律按拒绝收尾

三种情况下界面根本没机会展示，但请求已经发出去了：

| 情况 | 处理 |
|---|---|
| 事件里的 ACP 会话映射不到 UI 会话 | 记一条诊断，挑 `kind` 以 `reject` 开头的选项回写 |
| 用户关掉那个会话标签 | 关之前把该会话队列里剩下的请求逐条按拒绝回写，再清队列 |
| 连接配置被删 / 断开 | 同上（后端此时多半已清表，失败忽略即可） |

理由和 Esc 一样：悬空请求会让 agent 白等 300 秒，而用户侧什么迹象都没有。宁可显式拒绝并留日志，
也不要让它悬着 —— 失败就忽略，这条路径本来就没有人盯结果。

## 5. 失败一律不假装成功

界面上的「已应答」只在后端返回成功后成立。具体：

- 写回失败：队头留在原地，显示错误，用户可以再点；
- 后端报「已失效」：说明这一条已经答过了（另一个窗口/重复点击），把它从队列里摘掉，不要循环重试；
- 连接断开：整条队列作废（`PendingRequests::clear`），界面清掉提示而不是让它一直挂着。

## 6. 未实现的方法必须当场拒答

客户端只实现了 `session/request_permission`。其它 agent 发来的请求（`fs/read_text_file`、
`terminal/create` 等）现在一律回 JSON-RPC `-32601`，并且 `initialize` 的 `clientCapabilities`
把 `fs` / `terminal` 报成 `false`。

理由：一个不回的 JSON-RPC 请求会让 agent 一直等（hermes 默认 300s 才自拒），界面上什么都不会显示，
看起来像卡死。报真话 + 显式报错，至少错误出现在它该出现的地方。

## 7. 明确不做

- 本地 `permission_rules` / 项目级「永久信任」表：`allow_always` 的「记住」是 agent 的事，
  作用域也由 agent 定义；客户端自己再存一份会出现两套「不问」机制，语义重叠。留到需要时再议。
- 客户端侧超时自拒：协议没有超时，agent 自己有；我们加一层只会让两边计时不同步。
- `session/cancel`：客户端还没实现取消当前轮（这是另一件事），所以「回 `cancelled`」这条路径目前走不到，
  但一旦实现取消就必须回 `cancelled`，否则 agent 侧会留一个悬空请求。

## 8. 错误码

| 码 | 含义 |
|---|---|
| `50500` | 这个请求已失效或已被回答 |
| `50501` | 连接已断开，无法回答 |
| `50502` | 写回决定失败（登记已还回，可重试） |

## 9. 验收

自动（真机，需 WSL + hermes acp）：

```
cargo test --test permission_respond -- --ignored --nocapture --test-threads=1
```

两条断言：`default` 模式下能收到请求、回 `allow_once` 后该轮 `end_turn` 收尾；
`dont_ask` 模式下同样的任务全程不问。后者是前者的对照 —— 没有它，「模式生效」只是界面上的说法。

手工（界面）：

1. 连接 hermes，模式设为 `Default`，让它改一个文件 → 弹窗出现，标题是 `Approve edit: <path>`，
   按钮只有两个（`Allow once` / `Deny`）。
2. 点 `Allow once` → 弹窗消失，该轮继续；日志里有 `permission answered`。
3. 再让它改一个文件，这次按 Esc → 事件流里出现「拒绝」，agent 那边这一轮以拒绝收尾（不是卡住）。
4. 让它连续改两个文件 → 一次只显示一个，答完自动出下一个，标签角标在这期间是警示色。
5. 弹窗开着时点「断开连接」→ 弹窗消失，不残留提示。
6. 会话标签在弹窗未答时直接关掉 → 日志里出现一次拒绝回写，agent 那一轮以拒绝收尾而不是卡住。

## 10. 整轮放行：只放「本轮同类」（2026-10-26 定）

E13.6 卡上原写「批量/整轮放行的策略位（once / 本轮全部 / 拒绝并说明），默认 once」。
实现前把它收窄一档：**放行范围 = 同一会话的同一轮 + 同一 `kind`**，不做「本轮全部 kind」。

收窄的理由（写下来，免得日后当成偷懒）：一次点击放行整轮**所有类别**，与只放过
「这一类」不是同一量级的授权 —— 用户点「命令别再问了」，不该顺手把改文件也放过去。
「什么都别问」已经有另一条路（agent 档 `dont_ask`），不必在客户端再造一个更强的默认。

### 10.1 三档决策

```
一次（默认）      每条请求都问，答完即止
本轮同类全部允许   本条起，本轮内同 kind 的后续请求自动用请求自带的 allow 项应答
拒绝并说明        已有：拒绝 + 备注只进本地轨迹，不进协议
```

### 10.2 边界（沿用「自动同意的四条边界」，一条都不放宽）

- **空间**：当前 `uiSession` + 当前轮；换轮、取消、`conn.exited`、切换会话、应用退出 → 立即失效。
- **不落库**：策略是内存态（不写 settings、不写 DB），重启即失。
- **未知 kind 不自动答**；**options 里没有 `allow`/`always` 项时不自动答**，并照旧弹窗标「这条没法自动同意」；
  **请求已失效不自动答**。
- **看不见的不放行**：没有界面会话归属（`routes` 查不到）的请求一律按 §4.1 拒绝收尾，不进策略分支。

### 10.3 必须可查、可见、可撤

- 每条自动应答都写一条 `permission_decision`：`via = "turn-policy"`，`actorMemberId` 取该请求的发起成员
  （不是操作者），`note = "本轮同类自动允许"`。事后能查「谁的动作、被什么策略放行」。
- 生效期间输入区 chip 显示「本轮 · <kind 中文> · 已放行」，点一下撤销；撤销后下一条请求立刻恢复弹窗。

### 10.4 验收

```
同轮同类    第一条点「本轮同类允许」→ 第二条不弹窗，轨迹两条：一条 via=manual、一条 via=turn-policy
同轮异类    同一轮再来 execute（前一条是 edit）→ 仍弹窗
跨轮        下一轮的同类请求 → 仍弹窗
撤销        点 chip 撤销后同类请求立刻恢复弹窗
断线        连接断开后不产生自动应答（仍走 50501 路径）
```
