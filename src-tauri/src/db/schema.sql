-- SinceArc 本地库
-- 一个会话 = 一行：UI 会话 id 是主键，ACP 的 sessionId 只是它的一个字段。
-- （早期版本把 ACP id 当主键、靠前端一张映射表桥接两套 id，那样重启后映射还得重建。）

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS profiles (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  -- three launch kinds: 本机 / WSL / SSH（远程与 WSL 共用同一条 ssh 路径，只差 host）
  launch_kind   TEXT NOT NULL CHECK (launch_kind IN ('local', 'wsl', 'ssh')),
  distro        TEXT,
  shell         TEXT,
  program       TEXT NOT NULL,
  args_json     TEXT NOT NULL DEFAULT '[]',
  env_json      TEXT NOT NULL DEFAULT '{}',
  default_cwd   TEXT NOT NULL,
  -- 连接的默认编辑审批模式；NULL = 不推
  default_mode  TEXT,
  -- 这个连接默认注入的 MCP 名单；NULL = 继承目录全部，'[]' = 一个都不要
  default_mcp_json TEXT,
  -- SSH 凭证：密码不在这张表里（只在内存过一手）
  ssh_host      TEXT,
  ssh_port      INTEGER,
  ssh_user      TEXT,
  ssh_auth      TEXT,
  ssh_key_path  TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  profile_id    TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  roots_json    TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,          -- UI 侧会话 id
  acp_session_id TEXT,                      -- agent 侧 id；还没连过就是 NULL
  -- 会话覆盖值；NULL = 跟随连接默认
  mode_override  TEXT,
  -- 本会话的 MCP 名单；NULL = 继承连接默认，'[]' = 一个都不要
  mcp_names_json TEXT,
  profile_id     TEXT REFERENCES profiles(id) ON DELETE CASCADE,  -- 草稿会话可以为空
  title          TEXT NOT NULL DEFAULT '新会话',
  cwd            TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- 一个 ACP 会话只能挂在一个 UI 会话上
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_acp
  ON sessions(acp_session_id) WHERE acp_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_profile ON sessions(profile_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('user', 'player', 'agent', 'system')),
  kind         TEXT NOT NULL DEFAULT 'text',
  payload_json TEXT NOT NULL,               -- 原始消息对象，不做有损转换
  created_at   INTEGER NOT NULL,
  UNIQUE (session_id, seq)                  -- 流式重放的去重键
);

CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);

CREATE TABLE IF NOT EXISTS permission_rules (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  matcher       TEXT NOT NULL,
  decision      TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
  created_at    INTEGER NOT NULL
);

-- 键值元数据：目前放「agent 发现」的缓存（key = 'discovery'，value = JSON）。
-- 单独一张表而不是塞进 profiles：它描述的是这台机器扫出了什么，不隶属任何连接。
CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- MCP 目录：全局唯一一份配置。名单只存名字，配置只在这里（docs/mcp.md §3）。
CREATE TABLE IF NOT EXISTS mcp_servers (
  name        TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('stdio','http','sse')),
  config_json TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 群聊成员模型（docs/group-chat.md）：agent user 是全局实体，锚在某条连接的一个 ACP 会话上。
-- 同一个 (连接, 会话) 只能是一个人 —— 否则「两个人其实同一个会话」，群聊语义当场崩掉。
CREATE TABLE IF NOT EXISTS agent_users (
  id             TEXT PRIMARY KEY,
  profile_id     TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  acp_session_id TEXT NOT NULL,
  name           TEXT NOT NULL,
  handle         TEXT NOT NULL COLLATE NOCASE,
  color          TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  UNIQUE (profile_id, acp_session_id),
  UNIQUE (handle)
);

-- 群成员：一个 agent user 可以同时进多个群
CREATE TABLE IF NOT EXISTS session_members (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES agent_users(id) ON DELETE CASCADE,
  added_at   INTEGER NOT NULL,
  PRIMARY KEY (session_id, user_id)
);

-- 轨迹事件（思考 / 工具调用 / 权限 / 用量）：**源数据**，轨迹图由后端按需聚合，不在这里存。
-- 为什么自己记一份：ACP 没有「读历史」的标准方法，只有 session/load 的重放副作用；
-- 重放要起进程、思考还会残缺，也给不出发生时间。详见 docs/ipc-contract.md §7。
CREATE TABLE IF NOT EXISTS session_events (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  -- 一轮对话：与 messages 里那轮的提问/回答对齐（由 session_prompt 起算）
  turn_id      TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  -- 我们记下的发生时刻（agent 侧没有时间戳，只有到达顺序）
  at           INTEGER NOT NULL,
  -- 谁做的：群成员 id；主 agent 为 NULL
  author_id    TEXT,
  -- 自由字符串：新增轨迹种类（如 permission_decision）不需要迁移枚举
  kind         TEXT NOT NULL,
  -- 结构化摘要 + 原始字段；单行上限 64KB，思考正文只留前 8KB（truncated=1 时界面要标注）
  payload_json TEXT NOT NULL,
  -- live = 实时采集；replay = 事后用 session/load 补录（不作实时数据源）
  source       TEXT NOT NULL DEFAULT 'live' CHECK (source IN ('live', 'replay')),
  truncated    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_events_session ON session_events(session_id, seq);

-- 轮次：一次「提问 → agent 干完活」。轨迹按轮组织，没有它就只能看到一堆碎片事件，
-- 看不出「这一轮问了什么、用了多久、谁在写」。
CREATE TABLE IF NOT EXISTS turns (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  -- 提问正文（与 messages 里那条用户消息同源，但轨迹要能单独读，不靠前端猜）
  prompt       TEXT NOT NULL DEFAULT '',
  -- 这一轮是向谁提的：群成员 id；主 agent 为 NULL
  author_id    TEXT,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  -- running / waiting_approval / finished / cancelled / failed
  -- unknown 只用于「有事件、没有轮次行」的孤儿轮兜底
  status       TEXT NOT NULL DEFAULT 'running',
  -- agent 给的原始 stopReason（end_turn / max_tokens / refusal / cancelled …）
  stop_reason  TEXT
);

CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, started_at DESC);

CREATE TABLE IF NOT EXISTS session_bindings (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  acp_session_id TEXT NOT NULL,
  cwd            TEXT NOT NULL DEFAULT '',
  -- 上次成功握手/恢复时 agent 自报的名字。恢复时用它判断「还是不是同一个 agent」。
  agent_name     TEXT,
  -- 本地 session_events 已写到的最后一个 seq。恢复后拿第一条新事件与它比，判断有没有断档。
  last_event_seq INTEGER,
  bound_at       INTEGER NOT NULL,
  reason         TEXT NOT NULL CHECK (reason IN ('created', 'loaded', 'replaced')),
  superseded_at  INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_binding_live
  ON session_bindings(session_id) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_binding_session ON session_bindings(session_id, bound_at DESC);
