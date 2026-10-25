# 功能模型清单（Feature Map）

> 目的：一页看清「应用里到底有哪些功能、每个功能的实体与状态、现在到哪一步、缺口在哪」。
> 状态以代码为准，不等同于看板；看板负责排期，这里负责**模型是否完整**。

状态标记：`✅ 完成` / `🟡 完成但有缺口` / `⬜ 未开始`

## 总表

| # | 功能 | 主实体 | 关键状态 | 写入点 | 状态 | 缺口 |
|---|---|---|---|---|---|---|
| 1 | 连接管理 | `profiles` + 运行时进程 | 未连 / 连接中 / 已连 / 断开 | `profiles_save`、`agent_connect` | 🟡 | SSH 腿未真机验证（E1.1） |
| 2 | agent 发现 | 候选常量表 + `app_meta` 缓存 | 未扫 / 有结果 / 过期 | `agent_discover` | 🟡 | 同 1（SSH 未验） |
| 3 | CLI 扩展面板 | `extensions/registry.ts` | 只读预览 | 无（纯展示） | 🟡 | 命令未接线执行（E1.2a）、表未补齐（E1.2b） |
| 4 | 会话生命周期 | `sessions` | 草稿→已绑→运行中→空闲→已删 | `session_new` / `session_bind_acp` / `session_delete` | ✅ | — |
| 5 | 消息链路 | `messages` | 流式 → 定稿 / 失败 | `messages_append` | 🟡 | 流式观感未做补间（E5.1） |
| 6 | 群成员 | `agent_users` + `session_members` | 未测试→测试中→通过/失败 | `agent_user_save` / `session_member_add` | ✅ | — |
| 7 | `@` 提及 | 同上（成员关系即真源） | — | 无（投递走 `session_prompt`） | 🟡 | 被 @ 成员拿不到上下文（E2.2） |
| 8 | 权限应答 | `pending` 登记表 | 待答→已答/过期 | `agent_respond_request` | 🟡 | 无取消路径（E3.1） |
| 9 | 模式（编辑审批） | `sessions.mode_override` + `profiles.default_mode` | 跟随 / 覆盖 / 不推 | `session_apply_mode` | ✅ | — |
| 10 | 活动轨迹与写锁 | `atoms(channel='trace')`（`session_events` 是其视图）+ 内存视图 | 运行中→完成/错误 | `session_trace` | ✅ | 已落库并按轮聚合；思考按块入库（§12.1） |
| 11 | 设置页 | 各实体 | — | 多条命令 | ✅ | 发现/成员/诊断/外观都在 |
| 12 | 布局与主题 | 本地偏好 | — | 前端 | ✅ | — |
| 13 | 日志与诊断 | `sincearc.log` + 事件日志面板 | — | `client_log` | 🟡 | 用法未写进排障手册（L4） |
| 14 | 打包与分发 | — | — | — | ⬜ | E5 |

## 各功能的模型要点

### 1–3 接入层

- 一个 `profile` 表达「在哪启动 + 启动什么」：`launch_kind ∈ {local, wsl, ssh}` + `program/args/env/cwd`。
- **装了 CLI ≠ 能起 ACP**：候选表要区分 `native` 与 `adapter`；发现只报「在哪、什么命令、是不是适配器」，
  探测才回答「能不能起」。
- CLI 扩展（`hermes doctor` 之类）是**只读预览**，未接线前不计入功能完成度。

### 4 会话

- UI 会话先于 ACP 会话存在（草稿）；`acp_session_id` 可空、可变（重连换新会话）。
- 标题由首条用户消息生成；删除只删本地（消息 + 行 + 成员关系），agent 侧保留。
- 恢复：打开会话时按 `sessions.acp_session_id` 尝试 `session/load`，失败则新建（并留痕）。

### 5 消息

- 一条消息 = 一行 `messages`（`payload_json` 保存原对象，不做有损转换）。
- 一轮 = 一次 `session_prompt`；终态必须是「回答」或「失败原因」，不允许空白。
- 流式文本与定稿共用同一个 `msgId`（每条回答独立），定稿时 `ON CONFLICT` 只更新同一行。
- agent 在 `session/load` 后的**重放**不是新回答，丢弃并记 `DROP-REPLAY`。

### 6–7 群与提及

- 群 = 会话本身；成员关系多对多；成员身份全局唯一绑定 `(profile, acp_session)`。
- `@` 只认本群成员；对不上就明确失败（不偷偷投给主 agent）；回答按 `authorId` 归属到发言人。
- **上下文是接的下一件事**（E2.2）：现在只发用户原文，成员看不到主 agent 的工具结果。

### 8–9 权限与模式

- 权限：登记 → 界面队列 → 用户选择 → 写回；未实现的方法当场 `-32601`，不静默等待。
- 模式：连接默认 → 会话覆盖；推值前必须 `set_mode` 成功才落存储；agent 自报的模式只更新显示。

### 10 活动轨迹

目标有三个（所有者定义）：把思考/操作移出聊天正文、可溯源、群聊里分辨多个 agent 的交叉状态。

- 现状：只落了「回答」；`tool_call` / `tool_call_update` / `agent_thought_chunk` 收到就丢，
  `acts`/`turns`/写锁全由前端从事件推导，重启即失。
- 目标：`session_events` 落库（源数据），后端聚合出轨迹（派生视图），前端只渲染泳道。
- 证据（真机探针 `tests/replay_probe.rs`）：agent 侧 `session/load` 会重放整段历史**含 tool_call**
  （两轮 → 2×tool_call + 2×chunk），但思考残缺（只 1 条 thought）——所以实时采集才是可靠来源，
  重放只作补录。

### 11–14 外壳与交付

- 设置页承担配置 + 发现 + 成员 + 诊断；诊断面板要能作为 L4 排障入口。
- 打包未开始；在打好包之前，「重启后行为一致」只能靠手工验证。

## 与看板的映射

| 看板卡 | 对应上面哪几行 |
|---|---|
| E1.1 / E1.3 | 1、2 |
| E1.2 / E1.2a / E1.2b / E1.2c | 3（E1.2c 已实现） |
| E2.1 | 6、7 |
| E2.2 | 7 的缺口（上下文注入） |
| E3 / E3.1 / E3.2 | 8（含取消）、宿主能力 |
| E4 | 4、5 的恢复部分 |
| E5.1 | 5 的观感 |
| E6 | 10、3、11 里「前端在算」的部分 |
