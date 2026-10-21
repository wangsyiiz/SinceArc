# 群聊成员模型（E2.1）

把「群聊」从 mock 变成真实模型：**agent user 是全局实体**（固定在某个 agent 的一个 session 上），
**聊天 session 是群**，成员多对多。用户在群里 `@` 某个成员时，那条消息额外投递给它。

当前实现的差距（动代码前先认清）：

- `Player` 是静态 mock，连 `acpSessionId` 都没有，两个玩家还能挂同一个 profile；
- 真实链路只跑一个会话，回复一律渲染成 `players[0]`；
- `@handle` 只在 mock 分支生效。

---

## 1. 实体

| 实体 | 是什么 | 落在哪 |
|---|---|---|
| 连接（profile） | 「在哪台机器上跑哪个 agent」 | `profiles` |
| agent user | 一个可加入群聊的**玩家**：某条连接上某个 ACP 会话的人格 | `agent_users` |
| 群 | 一条聊天会话；它自己的 `acp_session_id` 是「主 agent」 | `sessions` |
| 成员关系 | 谁在哪个群里 | `session_members` |

要点：

- agent user **全局**，不属于某个群 —— 同一个玩家可以同时进多个群。
- `UNIQUE (profile_id, acp_session_id)`：同一条连接上的同一个 ACP 会话只能是一个人。否则「两个人其实是同一个会话」，
  群聊语义当场崩掉（现在的 mock 就有这个毛病）。
- `sessions` 表结构不动。它自己的 `profile_id` + `acp_session_id` 就是群的主 agent。

### 数据模型

```sql
agent_users (
  id             TEXT PRIMARY KEY,          -- 我们自己的 id
  profile_id     TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  acp_session_id TEXT NOT NULL,             -- 玩家的锚点，也是投递的地址
  name           TEXT NOT NULL,             -- 显示名
  handle         TEXT NOT NULL,             -- @ 用的短名，全局唯一（大小写不敏感）
  color          TEXT NOT NULL,             -- 头像/名字配色
  created_at     INTEGER NOT NULL,
  UNIQUE (profile_id, acp_session_id)
);

session_members (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES agent_users(id) ON DELETE CASCADE,
  added_at   INTEGER NOT NULL,
  PRIMARY KEY (session_id, user_id)
);
```

`messages` 加一列：`author_id TEXT`（`agent_users.id`，仅 `role='player'` 时有值）。
不这么做的话，多 agent 群里所有回复都长得一样，只能靠猜。

---

## 2. 创建流程（设置 → Agent Users）

前提：**必须先指定一条可用的连接（profile）**。没有连接的 sessionId 没法验证，也就没法保存。

两种入口，第一刀只做第一种：

1. **手动填已存在的 sessionId** —— 适合「我已经在别的客户端里开过这个 agent 会话，想把它的上下文搬进来」。
2. **自动在 agent 侧新建**（调 `session/new`）—— 体验最好，但要求同一 profile 下多会话并发稳定，
   这是连接层的一件事，单独立卡验证，不塞进这里。

### 保存前必须通过测试

- 表单有「测试」按钮，状态机：`未测试 → 测试中 → 通过 / 失败（带原因）`。
- 测试动作 = 拿这个 id **真跑一次 `session/load`**。
  **不要**用 `session/list` 判断：它只返回 agent 记着的列表，未必与用户输入一致，也判不出「这个 id 能不能恢复」。
- **改了任何一个字段就退回「未测试」**：否则会出现「用 A 的 id 测通了、改成 B 还显示通过」，存下去就是死条目。
- 没通过时保存按钮禁用，并写清为什么（不是灰着不解释）。

---

## 3. @ 投递规则

| 用户发的消息 | 投给谁 |
|---|---|
| 没有 `@` | 群的主 agent（`sessions.acp_session_id`） |
| `@handle` | 该成员所在连接的该 ACP 会话；主 agent 不参与 |
| `@` 了不存在的 handle | **明确报错**并把这条标成失败，不当普通文本投出去 |

细节：

- **一条消息只投一个目标**（第一刀）。多 `@` 扇出、主 agent 与成员同时回答，都要先想清「谁在读谁的回答」，不在这一刀。
- 成员那条连接不在线 → 先走无感连接（`ensureConnected`）；连不上就把原因写进这条消息的失败原因，不静默重试。
- 投递前**不**做「成员是否在群里」之外的权限判断：ACP 没有「只读成员」这种语义，别自己发明。
- `sessions.contextMessages` 仍然有效：`@` 时附带最近 N 条记录（数字在设置 → 群聊里，现在是 3）。

---

## 4. 消息归属与渲染

- 收到某成员的回答，写成 `role='player', author_id=<user_id>` 的消息；渲染时显示该成员的 name + color。
- `author_id` 指向已删除的 user（`ON DELETE CASCADE` 会让消息留空引用）→ 显示 agent 名，不留空洞。
- 主 agent 的回复保持 `role='agent'`（群主视角）。
- 失败消息 `role='system'`，正文写清「谁、为什么没投出去」，例如：
  `@后端-2 投递失败：连接 hermes · fedora 未连接（50200 启动失败）`。

## 5. 并发前提（写在这里，避免以后争论）

- 一条连接 = 一个 ACP 进程；同一进程内可以有多个 ACP 会话（`session/new` 多次），这是 ACP 的常规用法。
- 不同成员可以落在不同连接上 → 需要多条连接同时在线。前端 `useAgentConnect` 已经是按 profile 管理，
  后端 `state.agents` 也按 profile 存，结构上支持；**但没有实测过「两个连接同时跑长任务」**，
  这属于第二刀要验的事，第一刀只用一条连接内的多个会话。

## 6. 这一刀不做

- 自动 `session/new` 创建成员（连接层并发验证单独立卡）。
- 一条消息扇出给多个成员 / 让主 agent 旁听成员回答。
- 成员的角色与工具白名单（ACP 没有这个语义）。
- 跨群共享上下文、成员之间互相 `@`。

## 7. 验收

1. 设置里新建 agent user：随便填个假 id → 测试失败，保存按钮禁用，原因写清。
2. 填一个真实可恢复的 sessionId → 测试通过 → 保存 → 出现在群里。
3. 改一个字段（比如换了连接）→ 状态退回「未测试」，保存重新禁用。
4. 群里 `@` 成员发一句话 → 该成员的连接收到 prompt，回答记在它名下（名字 + 颜色）。
5. 不 `@` 直接发 → 投给主 agent。
6. `@不存在的人` → 这条消息标失败并说明原因，主 agent 收不到它。
7. 成员连接断开状态下 `@` 它 → 自动尝试连接；连不上就失败并说明，不重试三遍、不假装成功。
