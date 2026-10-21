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
