# 插话（steering）与斜杠命令（E13.10）

> 状态：合同已定（2026-10-25），实现待做。范围：GUI 封装，不做新的协议语义。
> 相关：`docs/acp-notes.md`（`/+` 命令的时序坑）、`docs/desktop-ux.md`（输入区工具行）。

## 1. 功能从哪来：ACP 没有 steering 原语

v1 的方法表只有 `session/new|load|set_mode|set_config_option|prompt|cancel|list|delete|fork|resume|close`，
没有 steer、queue、interrupt。所以「插话」只能是**往 `session/prompt` 里发一段文本**，由 agent 自己解释。

hermes 的 ACP 适配器里有两条相关通道（`acp_adapter/server.py`）：

```
/steer <文本>      走命令表（agent 在 availableCommands 里报的 steer 条目）
                   正在跑 → state.agent.steer(text) 注入当前轮，回一句「⏩ Steer queued for the active turn: …」
                   没在跑 → 落进 queued_prompts，回「No active turn — queued for the next turn」
忙碌时发普通正文   _claim_turn_or_queue：支持 active_turn_redirect 就「更正当前轮」
                   回「Redirected the active turn with your correction.」，否则排队
```

两条的共同点：**回包立刻 `end_turn` + 一条文本回执，不产生新轮次**。协议允许一轮在飞时再发 prompt，它被吸收掉。

## 2. 真机实测（2026-10-25，hermes）

在一轮正在生成时（`busy=true`）用现有 `session_prompt` 发 `/steer 主题改成杭州西湖，重写`：

| 观察 | 结果 |
|---|---|
| 命令层返回 | 33 ms 内 `ok`，不等这一轮 |
| agent 回执 | `⏩ Steer queued for the active turn: 主题改成杭州西湖，重写` —— 说明它认出这轮在跑 |
| `turns` 表 | **多出 1 行**（`turn-<ms>`），这一轮凭空变成两轮 |
| `messages` | 正在跑那轮的回答被**整条覆盖**：`seq 2` 存的是回执 `⏩ Steer queued…`，正文丢了 |
| 界面 busy | 插话的 `promptResult` 到达后**立刻变回「不在跑」**，而 agent 其实还在跑 |
| 副作用 | 紧接着 agent 发起的权限请求被判「已过期 · 这一轮已结束」 |

结论：**插话不能走 `session_prompt`**。它把「一次投递」当「一轮」处理，三处同时出错（正文被覆盖、busy 提前清、权限过期判定）。
正文被覆盖这一项的根因在 §5 末尾：流缓冲按 ACP 会话归并，没按 `messageId` 归并。

## 3. 形态

**入口 = 发送键的两副面孔**（所有者 2026-10-25 拍板，方案 A）：

```
空闲    [发送]        正文当一轮提问（现状不变）
在飞    [插话 ⏎]      只能是插话；仅当命令列表里有 steer 时出现
        没有 steer 时保持禁用，并在发送键上方一行说明「这个 agent 不支持插话」
```

不新增常驻控件、不进二级菜单 —— 会话级控件都在输入区工具行（与「自动同意」「MCP」同一行）。

**载荷 = agent 声明的命令**：`/steer <正文>`。命令名来自 `availableCommands`，不硬编码语义、不按 agent 名判断。

## 4. 落库与显示

插话内容按「旁注」落一条用户消息：`kind = "aside"`（`messages.payload_json.kind`）。

- 时间线上看得见「我当时纠正过它」，但不进 `turns`、不算提问、不参与轮次统计；
- agent 的回执**只用来判断收到了**，正文渲染成这一条下面的小字（`ink-3`、`text-caption`），
  不解析文案（英文串会变）、不做成功/失败判定；
- 刷新/重开会话，aside 仍在（因为它落库），回执不落库（那是 agent 的即时反应，不是内容）。

## 5. 通道：`session_steer`（新命令）

```
session_steer(sessionId, text, uiSessionId) -> ()
  ① 校验：会话存在、连接在、text 非空（trim 后）、命令列表里有 steer
  ② 发 session/prompt: "/steer <text>"，但**不开轮**：
     不写 turns、不记写锁、不推 promptStarted
  ③ 落下 aside 消息（role=user, kind=aside）+ 推事件 acp.aside{ sessionId, uiSessionId, text }
  ④ 给这一条 acp 会话打一个「aside 在飞」标记
```

**回执怎么归：靠 `messageId`，不设时间窗口、不丢正文**（2026-10-25 实测确认）

ACP 的 `ContentChunk` 有 `messageId`：「同一条消息的所有 chunk 共享同一个 `messageId`；
`messageId` 变化表示开始了新消息」。hermes 的流式正文**带** `messageId`，命令回执**不带**（省略）。
拿真 agent 直接探（约 500 个 chunk、期间插一句话）：

```
t=1.61s   messageId=None                     '⏩ Steer queued for the active turn: 改成杭州…'   ← 插话回执
t=2.0~14s messageId=3e002062-381d-4825-…     正文，全程同一个 id，534 个 chunk 无一例外
```

所以归因规则是确定的，没有「窗口内可能吃掉正文」这回事：

```
本轮正文的 messageId 已知（本轮已收到的 chunk 里带 id）
  aside 在飞时，messageId 为空 或 不在「本轮正文已见 id 集合」里的 chunk → 归这次插话（回执）
  带 id 的 chunk → 正文；id 变了 = 新消息（按 ACP 语义另起一条）
没有 aside 在飞时 → 一律按正文处理，行为不变
```

**门禁**：只有当这一轮的正文 chunk 确实带 `messageId` 时才提供插话入口。agent 不分组（正文也不带 id）
时不做插话 —— 那时回执和正文无法无损区分，宁可不给这个能力，也不拿「可能吃掉一段正文」的启发式顶上。
判定是运行时的：本轮已收到的 chunk 里出现过 id → 可用；一个都没有 → 发送键保持「发送」并说明原因。

顺带修一个真 bug：§2 里「正文被回执覆盖」的根因不是插话，是**我们的流缓冲按 ACP 会话归并、没有按
`messageId` 归并** —— 同一会话里来第二条文本流，就把第一条盖掉了。按 `messageId` 归并之后，
同一轮里换消息（工具调用后重新开口）也不会再互相覆盖。

**插话时不许动正在跑那一轮的任何状态**：`busy`、`awaiting`、`stream` 缓冲、写锁、`turns` 全部不碰。
只有「这一轮真的结束」（它自己的 `promptResult` / `promptFailed`）才清。

## 6. 斜杠命令菜单（同一批做）

`availableCommands` 已经在内存里（`AppState::Commands`，键 = ACP 会话 id，`session/new` 与 `session/load` 各推一份）。

- 输入框敲 `/` 且**光标在行首**（前面没有非空白）时弹出命令列表：单列、`name` + 灰色 `description`（单行截断）、
  上限 100 条；↑/↓ 选择、Enter/Tab 确认、Esc 关闭（不改输入内容）。
- 选中后把 `/name ` 填进输入框（有 `input.hint` 的不预填，让用户自己写参数），**不自动发送**。
- 发送仍然走普通 `session_prompt`：命令执行由 agent 解析正文完成，我们不加协议方法、不新开通道。
  命令的回执按普通回答显示（`/+` 的迟到文本窗口已覆盖这类回包，见 `docs/acp-notes.md`）。
- 没有命令列表的 agent（`availableCommands` 为空）→ 敲 `/` 什么都不弹，不显示空面板、不提示「暂无命令」。
- `/` 菜单与插话共用同一份命令列表；`steer` 这一条在菜单里照常出现（空闲时发它会落到「下一轮队列」，是 agent 的决定）。

## 7. 边界

- **不做主动 steering 语义**：插话就是 `/steer` 文本，agent 说排队就排队、说注入就注入，我们不排队、不重发、不判断。
- **不新增协议方法**，不造 `_meta` 字段，不解析任何回执文案。
- **agent 没报 steer 就不出现插话入口**（不是置灰占位、不按 agent 名猜）。
- **agent 的正文不带 `messageId` 时也不提供插话**：回执与正文无法无损区分，宁可没有这个能力（§5 门禁）。
- **空闲时没有插话入口**（空闲就是正常发送）；也不做「排队下一条」的 UI —— 那是 `/queue`，暂不进界面。
- 插话只作用于**当前这条 ACP 会话**；群聊里对某个成员插话，不影响其他成员。

## 8. 验收

1. 真机：一轮在飞时发送键变成「插话」；点它 → 时间线出现 aside 用户消息 + 回执小字；
   **正在跑那轮的回答仍然完整**（不被回执覆盖）、`busy` 保持到它自己结束、权限请求不判过期。
2. `turns` 不因插话新增行；`messages` 里 aside 的 `kind` 为 `aside`，刷新后仍在。
3. agent 不报 steer（例如 codex）时：在飞状态下发送键禁用并写明原因，菜单里也没有插话入口。
4. `/` 菜单：行首敲 `/` 弹出、↑↓/Enter/Esc 可用、选中只填入不发送；命令为空时不弹。
5. 门禁：`cargo test --lib`、clippy、`tsc -b`、前端 `node --test`、`vite build`。
