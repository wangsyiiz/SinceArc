# SinceArc 应用层架构

> 这份文档回答三件事：**有哪些实体、谁说了算、数据怎么流**。
> 具体功能的设计在各 feature 文档里（`group-chat.md` / `modes-spec.md` / `permissions-spec.md` /
> `discovery.md` / `desktop-ux.md`）；本文只定跨功能的骨架，改动骨架必须先改本文。

## 1. 产品形态

通用 ACP 客户端：一个本地应用，能起/连多个 agent（本机、WSL、SSH），把每次对话当作**会话**，
把多个 agent 身份当作**群成员**，让用户在同一个群里与多个 agent 交互。

它**不是**某个 agent 的壳：连接必须同时表达「在哪启动」与「启动哪个 agent」，
协议行为按 ACP 标准实现，不自创语义。

## 2. 四个 id，四种所有权

出过的绝大多数「消息串会话 / 回答丢失」都源于把这几层混着用。定死如下：

| 层 | 标识 | 谁创建 | 权威存在哪 | 生命周期 | 前端能看到吗 |
|---|---|---|---|---|---|
| 连接 | `profile.id` | 用户（设置页） | `profiles` 表 + 运行时进程表 | 用户删除为止 | 是（配置） |
| agent 侧会话 | `acp_session_id` | **agent**（`session/new` 返回） | agent 自己；我们只在 `sessions.acp_session_id` 记引用 | agent 决定 | 只作展示/排障 |
| 界面会话（=群） | `sessions.id`（`s-…`） | **我们** | `sessions` 表（主键） | 用户删除为止 | 是（侧栏条目） |
| 群成员身份 | `agent_users.id` | 用户（设置页「成员」） | `agent_users` 表 | 用户删除为止 | 是（发言人名字/颜色） |

三条硬结论：

1. **唯一持久身份是 `sessions.id`**。它先于任何 ACP 会话存在（草稿会话 `acp_session_id` 为 NULL），
   也可能在一个 UI 会话里先后挂过不同的 ACP 会话（重连）。
2. **`acp_session_id` 是凭证，不是可变字段**。它由 agent 分配，是我们**在 agent 上找回那个会话的唯一凭据**。
   一旦绑上，就不许「顺手改掉」—— 改了等于我们库里挂在它下面的消息归属、成员身份、
   模式覆盖全部指向一个不存在或不对应的会话（数据变脏、且无法判真伪）。
   所以：
   - **绑定只有两个入口**：`session/new` 得到新会话（草稿 → 已绑）、`session/load` **验证成功**（恢复）。
   - 已绑的会话**不允许静默改** `acp_session_id`；需要换会话时是一次显式的「重建」动作：
     旧绑定进 `session_bindings` 历史（带原因 `created/loaded/replaced`），新绑定写当前指针，
     界面必须看得见「这个会话换过 agent 侧会话」。
   - `session/load` 失败（agent 不认这个 id）→ 标 `invalid` 并提示重建，**不许悄悄换一个新 id** 顶上。
   - 成员的 `agent_users.acp_session_id` 同理：一经保存不可编辑；要换 = 新建成员，旧成员保留历史归属。
   - 删我们的会话仍然不动 agent 侧的会话（见 INV-7）。
3. **成员是全局实体，群是关系**：一个 agent user 锚在 `(profile_id, acp_session_id)` 上，
   通过 `session_members` 加入任意多个群。`@` 只认**本群成员**。

## 3. 数据怎么流

```
            命令（上行，必须带完整身份）
   UI ─────────────────────────────────────▶ Rust 命令层
      agent_connect(profile, uiSessionId)
      session_new(profileId, cwd, uiSessionId)
      session_load(profileId, acpSessionId, cwd, uiSessionId)
      session_prompt(sessionId, text, uiSessionId)
                                                  │
                                                  ├─▶ 进程/协议（acp/*）
                                                  └─▶ 持久化（db/*）
                                                        ▲
            事件（下行，必须带归属）                     │ 历史只从库读
   UI ◀────────────────────────────────────────────────┘
      notification / request / promptStarted / promptResult / promptFailed
      每个都带 sessionId(ACP) + uiSessionId + authorId
```

规则：

- **上行**：任何改变状态或产生数据的命令，都必须显式带上「这次操作属于哪个界面会话」。
  禁止命令层从「最近一次操作」「当前打开的会话」推断。
- **下行**：事件由**后端**按会话归属填好投递目标；前端只做「能投就投，投不了丢弃并留痕」。
- **历史**：库是唯一权威。界面里的消息列表是投影/缓存，切会话必须重新读库并合并。
- **计算**：业务计算在后端；前端只做布局、动画、输入可用性。

## 4. 不变量（Invariants）

违反任何一条都视为 bug，而不仅是「体验问题」。

| # | 不变量 | 落点 |
|---|---|---|
| INV-1 | 出站事件必须带 `uiSessionId`；没有归属就不投递，并记 `DROP-NOMAP` | `commands.rs` 转发 task + `useAcpEvents` |
| INV-2 | 每条消息主键全局唯一、永不复用（一条回答一个 id） | `useAcpEvents` 的 `StreamState.msgId` |
| INV-3 | 一轮 prompt 必须留下**恰好一条**终态记录：回答，或失败原因 | `promptResult` / `promptFailed` 分支 |
| INV-4 | 历史只从库读；内存非空也必须重读并合并 | `useSessionState` |
| INV-5 | 一个 `acp_session_id` 同时只属于一个 UI 会话 | `idx_sessions_acp` 唯一索引 |
| INV-6 | 一个 `agent_user` 唯一绑定 `(profile_id, acp_session_id)`；任一字段变更即退回「未测试」 | schema 唯一约束 + `AgentUsers` |
| INV-7 | 破坏性操作只删本地记录、只在用户显式确认后执行；agent 侧产物（会话/文件）我们不动；正在跑一轮的会话禁止删除 | `session_delete` + `ConfirmDialog` |
| INV-8 | 前端不计算业务；所有尺寸/高度必须实测，禁止常数估算布局 | `dev-rules.md` 禁用清单 |
| INV-9 | 绑定是凭证：`acp_session_id` 一旦写入不可静默修改；换会话必须走显式「重建」并留历史 | `session_bindings` + `session_bind_acp` |
| INV-10 | IPC 只有一个事件通道与一层类型契约；业务代码不得直接 `invoke` | `docs/ipc-contract.md` |

## 5. 状态机

**会话**：`draft`（无 acp id）→ `bound`（有 acp id）→ `running`（一轮在跑）→ `idle` → … → `deleted`
- 只有 `bound` 才能 `prompt`；`running` 期间禁止删除（E3.1 之前）。

**群成员**：`untested` → `testing` → `ok` / `fail(带原因)`
- 测试=真跑 `session/load`（新建入口则 `session/new` 成功即 `ok`）；字段变更退回 `untested`。

**权限请求**：`pending`（登记在 `PendingRequests`）→ `answered` / `expired`
- 不做「默认允许」；无法投递的请求按**拒绝**收尾，绝不静默等待。

## 6. 模块边界

### 6.1 地基与业务必须解耦（硬规则）

「地基」= 通信层、持久化层、外部适配器（acp 进程 / gh CLI）。它们**不认识业务**：

| 地基 | 只能做 | 绝对不能出现 |
|---|---|---|
| 通信层（`lib/ipc/*`、Tauri 信封） | 传输、序列化、错误码搬运、seq | 「这个会话是群还是单聊」「成员该怎么校验」「PR 该怎么排」 |
| 持久化（`db/*`） | SQL、行↔结构体、事务 | 「如果模式是 X 就推 Y」「成员测试通过才允许保存」 |
| 适配器（`acp/*`、`gh/*`） | 进程、协议、命令解析、超时 | 会话归属、UI 状态、业务默认值 |

判定标准（review 时一句话问）：**把这条业务规则拿掉，地基还能编译、还能跑吗？**
不能，就说明业务逻辑漏进地基了。

依赖方向只允许一列：

```
视图(components) → 状态(hooks) → 通信(lib/ipc) → 命令层(commands.rs) → 领域服务 → 适配器/持久化
```

反向 import 一律禁止（适配器 import 视图类型、db import 命令层、ipc 层 import 领域模型做判断）。
类型可以共享（`types.gen.ts`），**逻辑不行**。


| 层 | 目录 | 只做 | 禁止 |
|---|---|---|---|
| 协议 | `src-tauri/src/acp/` | 进程启动、JSON-RPC、能力解析、发现 | 碰 UI 状态、直接写库 |
| 持久化 | `src-tauri/src/db/` | SQL、schema、行↔结构体 | 业务判断、发起网络/进程操作 |
| 编排 | `src-tauri/src/commands.rs` | 校验入参、错误码、编排、事件归属 | 内联复杂 SQL、把 UI 概念写进协议层 |
| 传输 | `src/lib/ipc.ts` | 命令/事件类型与封装 | 计算、缓存业务状态 |
| 状态 | `src/hooks/` | 缓存后端状态、派生展示数据 | 决定归属、实现业务规则 |
| 视图 | `src/components/` | 渲染、交互、动画 | 直接 invoke 后端（除设置类除外，见规范） |

## 7. 错误语义

错误码分区（新增错误必须落在既有区内，不许造新段）：

| 段 | 含义 |
|---|---|
| `50100`–`50199` | 入参/配置缺失（本地就能判定） |
| `50200`–`50299` | 启动/握手失败 |
| `50300`–`50399` | 会话不存在 / 未连接 / 空消息 |
| `50400`–`50499` | 模式（set_mode / load / 不支持） |
| `50500`–`50599` | 权限请求（失效 / 断连 / 写回失败） |
| `50600`–`50699` | 群成员（handle 占用 / 同会话两身份 / 字段为空） |
| `50700`–`50799` | 客户端日志等辅助设施 |

规则：**服务端认为请求错了就按错误返回**，不把错误状态混进业务语义；前端只把码翻成人话，
不做二次判断（例如「是不是短名有空格」不在前端判断）。

## 8. 事件契约

| 事件 | 必带字段 | 用途 |
|---|---|---|
| `notification` | `sessionId`、`uiSessionId`、`authorId`、`method`、`params` | 流式正文、工具调用、模式变更 |
| `request` | 同上 + `id` | 权限请求（待用户回答） |
| `promptStarted` | `sessionId`、`uiSessionId`、`authorId` | 进入生成态；同时标记「这一轮是我们发起的」 |
| `promptResult` | 同上 + `result` | 定稿落库、结束生成态 |
| `promptFailed` | 同上 + `msg` | 落库失败原因（不留空白提问） |

`hello` / `exited` 是连接级事件，不带会话归属。

## 9. 演进规则

- 加字段：向后兼容，旧前端忽略即可。
- 改语义：必须先改本文 + 对应 feature 文档，再改代码。
- 表结构：只加列/加表；迁移写在 schema，测试里要有「旧库升级后能打开」的用例。
- 命令签名变更：同步 `src/lib/ipc.ts` 与调用点，并检查「是否有调用方漏传 uiSessionId」。
