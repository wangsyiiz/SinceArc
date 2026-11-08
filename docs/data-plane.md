# 数据面：分层、单一解析口、切换必须完整

> 由来：2026-10-25 真机发现「新建会话」共用了连接当前的那条 ACP 会话 —— 两条界面会话上下文串台，
> 同时状态栏、模式切换也在读「连接当前会话」。这不是一处笔误，是**展示数据面里混了两个层的键**。
> 本文定死分层与解析口，后面按这份改，不再逐处打补丁。

## 1. 分层：谁是键，谁从属

```
L0 连接   profile        进程 / 握手 / 能力 caps / 连接态          （一条连接 = 一个 agent 进程）
L1 会话   acpSessionId   一条 agent 侧会话；上下文隔离的单位         （一个进程内可以有多条）
L2 界面   uiSessionId    标签页 / 侧栏条目；与 L1 一对一，可为空（还没建）
L3 轮     turnId         一次 prompt 的往返：状态、stopReason
L4 消息   message(id)    正文 / 旁注 aside / 派活发起行；带 kind
L5 轨迹   session_events thought / tool_call / permission，属于某一轮
```

> 存储形态（2026-10-26 M2 之后）：L4 与 L5 的**唯一写入表是 `atoms`**，按 `channel` 分
> `chat` / `trace` 两条流；`messages`、`session_events` 这两个名字现在是 atoms 上的同名视图，
> 列与旧表一一对应。读代码时把它们当「视图」看，写代码时只能写 atoms
> （见 `docs/message-model.md` §12–§14）。

两条硬规则：

1. **上层 id 只能从下层派生**。界面只持有 `uiSessionId`；`profileId`、`acpSessionId`、
   `turnId` 全部由它解析或由事件携带，不许「看当前活跃的是谁」去猜。
2. **一个键只能有一个来源**。同一层同一实体有多处副本（数据库、事件流、内存表）时，
   解析顺序写死在 §2 一处，别的地方读解析结果，不各读各的。

## 2. 单一解析口

前端只允许一个解析函数（hook），其余地方一律消费它的返回值：

```
useSessionView(uiSid) -> { profileId, acpSessionId, cwd, connected }
  ① sessions 表里这条会话的 acpSessionId / profileId
  ② 事件流学到的映射 uiSid -> acpSessionId（新建会话的数据库列可能还没回填）
  ③ 都没有 → null（**不猜**「连接当前会话」，也不借用别的会话）
```

消费点清单（都必须用它，一个都不许自己拼）：发送 / 停止 / 模式切换 / 状态栏 /
能力面板与命令列表 / MCP 芯片 / 轨迹面板 / 输入区 busy 与插话入口 / 派活目标。

**禁止**：把 `sessionsByProfile[profileId]`（语义 = 这条连接当前的会话）当作某条界面会话的
展示或投递数据源。它只允许出现在「连接管理」内部（连接、断线、重连、恢复判定）。
它的名字就是坑 —— 读到它的人会以为「这个 profile 的会话」。

## 3. 切换数据面必须完整

一次界面切换（打开另一条会话、切标签、关标签回到前一条）之后，页面上**每一处**显示该会话状态的位置
都必须来自新的 `uiSid`：

```
消息流            ✓ 按 uiSid
状态栏            事件计数 / 模式 / 恢复态 / 连接态
顶部能力面板      8 布尔 + 命令列表
输入区            busy / 插话门禁 / MCP 芯片
停止按钮          目标 acpSessionId
轨迹面板          按 uiSid 读
右侧面板          成员 / 审批
```

判定只有一句：**切换后任何一个位置还在显示上一条会话的数据，就是 bug**；
组件局部状态同样归 `uiSid`：滚动位置、输入草稿这些不是「数据源」，但它们在切换后留着，效果与串台一样（`docs/desktop-ux.md §38`：滚动位置按会话恢复、草稿按会话保留、其余重置）。

「碰巧两边一样」不算正确（这正是串台能活到现在的原因）。

兜底：解析不到 `acpSessionId` 就按「这条会话还没有 agent 会话」显示（空态 / 等正文 / 不可插话），
绝不去借连接当前会话顶上。

## 4. 检查方式

- 守卫测试 `src/lib/data-plane.test.ts`：扫描 `src/`，`sessionsByProfile[` 只允许出现在白名单文件
  （连接管理 hook、`usePrompt` 的建会话分支）；出现在展示/组件代码里即失败。
- 不变量：同一 `uiSid` 在发送、停止、模式、状态栏拿到的 `acpSessionId` 必须相同 —— 由单一解析口保证，
  测试对它做一次双向断言（有绑定 / 无绑定两种）。
- 真机验收补两条：① 连开两条新会话互不串台（记 41 / 问 41）；② 在 A 会话切模式，B 会话的模式与状态栏不变。

## 5. 凭证在库里 ≠ 会话在进程里活着（2026-11-08 定）

L1（`acpSessionId`）有两个**互不蕴含**的事实，必须在同一条链路上分别回答：

| 事实 | 谁回答 | 判据 |
| --- | --- | --- |
| 凭证有效 | agent | 只有 `session/load` 成功才算「agent 那边还记得这条会话」 |
| 会话活着 | 我们（`state.sessions`，**进程内**表） | 本进程 `session/new` 或 `session/load` 成功过才有这条记录 |

进程重启、断线重连之后，`state.sessions` 是空的，而 `sessions.acp_session_id` 仍是一条有效凭证 ——
两者不一致是**常态**，不是异常。此时直接 `session/prompt` 只会拿到我们自己的 `50300 未知会话`，
而 agent 侧那条会话好得很（真机：hermes 会话列表里一直在，`session/load` 能接回来）。

规则：

1. **投递前必须保证 L1 活着**，唯一入口是后端 `ensure_live_session`（`session_prompt` 与 `session_steer` 共用）：
   内存/handle 表里有 → 直接用；没有 → 拿库里的凭证跑一次 `session/load`，走的仍是连接恢复那套
   `load_resume_handle`（绑定、`modes` 快照、agent 名、`acp_state=invalid` 的口径与「打开会话」完全一致，不另写一份）。
2. **失败态不许一律报「未知会话」**，按原因分开：
   - 库里没有这条凭证 / 凭证属于别的界面会话 → `err.session.notFound`（这才是真未知）
   - agent 没报 `loadSession` → `err.session.resumeUnsupported`
   - `session/load` 被明确拒绝 → `err.session.resumeUnavailable`（并按 `architecture.md` §2 标 `acp_state=invalid`）
   - 超时 / 断管 → 同样报 `err.session.resumeUnavailable`（`reason` 里带传输错误原文），
     但**不标** `invalid`：失效只能由 agent 明确拒绝触发（`load_resume_handle` 已经这么分）
3. **前端不判断「能不能发」**：它只持有凭证 id，活不活只有后端知道（硬规则 ②）。`usePrompt` 继续用
   `acpSessionOf(uiSid)` 当投递目标，不再自行预检。
4. **成本写在这里**：一次 load 会把历史重放一遍（实测 `local-87956a…` 约 1.9 万条事件）。重放期由
   `agent_turns.load_begin` 抑制合成轮，正文按「不在飞且不在迟到窗口」丢弃（`DROP-REPLAY`）。
   于是「重启后第一次发消息」是慢的那一次，界面靠 `busy` 表达，不额外加提示。

验收（真机，两进程）：

- 关掉应用再开 → 打开一条旧会话直接发消息：`sincearc.log` 依次出现 `session auto-loaded before prompt`、
  `prompt sent`，没有 `50300`；
- hermes 侧会话列表里**不多出一条空会话**（走的是 load，不是 new）；
- 把 agent 侧的会话删掉再发：报 `err.session.resumeUnavailable`，界面写明原因，不是「未知会话」。
