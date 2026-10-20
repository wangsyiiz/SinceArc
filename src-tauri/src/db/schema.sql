-- SinceArc 本地库（v1 建表，E4 接线）
-- 扩展预留：workspace 是 fs 沙箱的根，不是 UI 分组

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
  roots_json    TEXT NOT NULL,           -- WSL 内或本地的绝对路径数组
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,        -- ACP sessionId
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  cwd           TEXT NOT NULL,
  title         TEXT,
  state         TEXT NOT NULL DEFAULT 'active'
                CHECK (state IN ('active', 'closed', 'crashed')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('user', 'agent', 'system')),
  kind          TEXT NOT NULL,           -- text | thinking | tool_call | plan | notice
  payload_json  TEXT NOT NULL,           -- 原始 content block，不做有损转换
  created_at    INTEGER NOT NULL,
  UNIQUE (session_id, seq)               -- 流式去重的键
);

CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

CREATE TABLE IF NOT EXISTS permission_rules (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,           -- fs.write | terminal.exec | ...
  matcher       TEXT NOT NULL,           -- 路径前缀 / 命令名
  decision      TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
  created_at    INTEGER NOT NULL
);
