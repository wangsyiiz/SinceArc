//! 本地持久化（SQLite）。
//!
//! 一个会话 = 一行：**UI 会话 id 是主键**，ACP 的 sessionId 只是它的一个字段。
//! 早期版本反过来（ACP id 当主键 + 前端一张映射表桥接两套 id），那样每次重启
//! 都要重建映射，而且映射一旦没建立，流式内容就会写到别处去。
//!
//! `profiles` 存连接配置（SSH 密码不入库）、`sessions` 存会话列表、
//! `messages` 存消息。`workspaces` / `permission_rules` 是 E4 预留，尚未接线。

use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::commands::ProfileDto;

pub const SCHEMA: &str = include_str!("schema.sql");

/// 结构版本：与 schema.sql 不符时整表重建（自用工具，会话数据可再生）
const SCHEMA_VERSION: i64 = 4;

pub struct Db {
    conn: Mutex<Connection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub id: String,
    pub acp_session_id: Option<String>,
    pub mode_override: Option<String>,
    /// 还没绑定连接配置的草稿会话为 None
    pub profile_id: Option<String>,
    pub title: String,
    pub cwd: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 一条待落库的轨迹事件（已由 `trace` 解析、截断）。
pub struct EventInput {
    pub turn_id: String,
    pub author_id: Option<String>,
    pub kind: String,
    pub payload_json: String,
    pub source: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRow {
    pub id: String,
    pub seq: i64,
    pub at: i64,
    pub turn_id: String,
    pub author_id: Option<String>,
    pub kind: String,
    pub payload_json: String,
    pub source: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRow {
    pub id: String,
    pub seq: i64,
    pub role: String,
    pub author_id: Option<String>,
    pub kind: String,
    /// 原始消息对象（前端 `Message` 的形状），不做有损转换
    pub payload: serde_json::Value,
    pub created_at: i64,
}

/// 一个可加入群聊的玩家（docs/group-chat.md §1）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUserRow {
    pub id: String,
    pub profile_id: String,
    /// 投递地址：该成员在自己那条连接上的 ACP 会话
    pub acp_session_id: String,
    pub name: String,
    pub handle: String,
    pub color: String,
    pub created_at: i64,
}

/// 写入用：seq 由后端按 MAX+1 分配，前端不需要知道
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageInput {
    pub id: String,
    pub role: String,
    /// 仅 role = 'player' 时有值：这条回答出自哪个 agent user（docs/group-chat.md §4）
    #[serde(default)]
    pub author_id: Option<String>,
    #[serde(default = "default_kind")]
    pub kind: String,
    pub payload: serde_json::Value,
}

fn default_kind() -> String {
    "text".to_string()
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// CREATE TABLE IF NOT EXISTS 不会给旧表补列；每加一列都要在这里登记一次，
/// 否则老库打开后一查新列就报 no such column。
fn ensure_column(conn: &Connection, table: &str, column: &str, decl: &str) -> rusqlite::Result<()> {
    let exists: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = ?1"),
        params![column],
        |r| r.get(0),
    )?;
    if exists == 0 {
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"))?;
    }
    Ok(())
}

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;

        // 旧结构（sessions 缺 acp_session_id 列）直接重建，不做逐列迁移：
        // 会话数据可再生产，留着半旧表只会让后面每一步都要判断两套结构。
        let has_table: bool = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sessions'",
            [],
            |r| r.get::<_, i64>(0),
        )? > 0;
        let has_column: bool = if has_table {
            conn.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name='acp_session_id'",
                [],
                |r| r.get::<_, i64>(0),
            )? > 0
        } else {
            true
        };
        if has_table && !has_column {
            tracing::warn!(
                target: "sincearc::ipc",
                "旧库结构，重建 sessions/messages 表（配置保留）"
            );
            conn.execute_batch(
                "DROP TABLE IF EXISTS messages;
                 DROP TABLE IF EXISTS sessions;",
            )?;
        }

        conn.execute_batch(SCHEMA)?;
        ensure_column(&conn, "profiles", "default_mode", "TEXT")?;
        ensure_column(&conn, "sessions", "mode_override", "TEXT")?;
        // 群聊里的消息要能指认「谁说的」：不加这列，多 agent 群所有回复长得一样（docs/group-chat.md §4）
        ensure_column(&conn, "messages", "author_id", "TEXT")?;
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /* ---------------- profiles ---------------- */

    pub fn load_profiles(&self) -> rusqlite::Result<Vec<ProfileDto>> {
        let conn = self.conn.lock().expect("db poisoned");
        let mut stmt = conn.prepare(
            "SELECT id, name, launch_kind, program, args_json, default_cwd,
                    distro, shell, ssh_host, ssh_port, ssh_user, ssh_auth, ssh_key_path,
                    default_mode
             FROM profiles ORDER BY created_at ASC, id ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            let args_json: String = r.get(4)?;
            Ok(ProfileDto {
                id: r.get(0)?,
                name: r.get(1)?,
                launch: r.get(2)?,
                program: r.get(3)?,
                args: serde_json::from_str(&args_json).unwrap_or_default(),
                cwd: r.get(5)?,
                default_mode: r.get(13)?,
                distro: r.get(6)?,
                shell: r.get(7)?,
                ssh_host: r.get(8)?,
                ssh_port: r.get::<_, Option<i64>>(9)?.map(|p| p as u16),
                ssh_user: r.get(10)?,
                ssh_auth: r.get(11)?,
                ssh_key_path: r.get(12)?,
                // 密码从不落盘：读回来永远是 None
                ssh_password: None,
            })
        })?;
        rows.collect()
    }

    /// 整表对齐：列表里的 upsert，不在列表里的删掉（会话随外键级联）。
    pub fn save_profiles(&self, list: &[ProfileDto]) -> rusqlite::Result<()> {
        let mut conn = self.conn.lock().expect("db poisoned");
        let tx = conn.transaction()?;
        let ts = now();

        for p in list {
            let args = serde_json::to_string(&p.args).unwrap_or_else(|_| "[]".into());
            tx.execute(
                "INSERT INTO profiles
                   (id, name, launch_kind, distro, shell, program, args_json, env_json,
                    default_cwd, default_mode, ssh_host, ssh_port, ssh_user, ssh_auth, ssh_key_path,
                    created_at, updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,'{}',?8,?9,?10,?11,?12,?13,?14,?15,?15)
                 ON CONFLICT(id) DO UPDATE SET
                   name=excluded.name, launch_kind=excluded.launch_kind,
                   distro=excluded.distro, shell=excluded.shell,
                   program=excluded.program, args_json=excluded.args_json,
                   default_cwd=excluded.default_cwd, default_mode=excluded.default_mode,
                   ssh_host=excluded.ssh_host,
                   ssh_port=excluded.ssh_port, ssh_user=excluded.ssh_user,
                   ssh_auth=excluded.ssh_auth, ssh_key_path=excluded.ssh_key_path,
                   updated_at=excluded.updated_at",
                params![
                    p.id,
                    p.name,
                    p.launch,
                    p.distro,
                    p.shell,
                    p.program,
                    args,
                    p.cwd,
                    p.default_mode,
                    p.ssh_host,
                    p.ssh_port.map(|v| v as i64),
                    p.ssh_user,
                    p.ssh_auth,
                    p.ssh_key_path,
                    ts
                ],
            )?;
        }

        let keep: Vec<String> = list.iter().map(|p| p.id.clone()).collect();
        let existing: Vec<String> = {
            let mut stmt = tx.prepare("SELECT id FROM profiles")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let doomed: Vec<String> = existing
            .into_iter()
            .filter(|id| !keep.contains(id))
            .collect();

        if !doomed.is_empty() {
            let marks = std::iter::repeat("?")
                .take(doomed.len())
                .collect::<Vec<_>>()
                .join(",");
            // workspaces 对 profiles 是 RESTRICT（防误删沙箱根），删除顺序显式写出来
            tx.execute(
                &format!("DELETE FROM workspaces WHERE profile_id IN ({marks})"),
                rusqlite::params_from_iter(&doomed),
            )?;
            tx.execute(
                &format!("DELETE FROM profiles WHERE id IN ({marks})"),
                rusqlite::params_from_iter(&doomed),
            )?;
        }

        tx.commit()
    }

    /* ---------------- sessions ---------------- */

    pub fn list_sessions(&self, profile_id: Option<&str>) -> rusqlite::Result<Vec<SessionRow>> {
        let conn = self.conn.lock().expect("db poisoned");
        let sql = "SELECT id, acp_session_id, profile_id, title, cwd, created_at, updated_at,
                          mode_override
                   FROM sessions
                   WHERE (?1 IS NULL OR profile_id = ?1)
                   ORDER BY updated_at DESC, created_at DESC";
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(params![profile_id], |r| {
            Ok(SessionRow {
                id: r.get(0)?,
                acp_session_id: r.get(1)?,
                profile_id: r.get(2)?,
                title: r.get(3)?,
                cwd: r.get(4)?,
                created_at: r.get(5)?,
                updated_at: r.get(6)?,
                mode_override: r.get(7)?,
            })
        })?;
        rows.collect()
    }

    pub fn upsert_session(&self, row: &SessionRow) -> rusqlite::Result<()> {
        let conn = self.conn.lock().expect("db poisoned");
        conn.execute(
            "INSERT INTO sessions (id, acp_session_id, profile_id, title, cwd, created_at, updated_at,
                                   mode_override)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
             ON CONFLICT(id) DO UPDATE SET
               -- 绑定过的 ACP id 不能被一次空值覆盖掉
               acp_session_id = COALESCE(excluded.acp_session_id, sessions.acp_session_id),
               profile_id = excluded.profile_id,
               title = excluded.title,
               cwd = excluded.cwd,
               -- mode_override 只由 set_mode_override 在用户手切成功后写；
               -- 普通会话保存不带该字段，跟着 excluded 更新会把覆盖值误清成 NULL。
               updated_at = excluded.updated_at",
            params![
                row.id,
                row.acp_session_id,
                row.profile_id,
                row.title,
                row.cwd,
                row.created_at,
                row.updated_at,
                row.mode_override
            ],
        )?;
        Ok(())
    }

    pub fn bind_acp_session(&self, id: &str, acp_session_id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().expect("db poisoned");
        conn.execute(
            "UPDATE sessions SET acp_session_id = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, acp_session_id, now()],
        )?;
        Ok(())
    }

    pub fn mode_override(&self, ui_session_id: &str) -> rusqlite::Result<Option<String>> {
        let conn = self.conn.lock().expect("db poisoned");
        conn.query_row(
            "SELECT mode_override FROM sessions WHERE id = ?1",
            params![ui_session_id],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()
        .map(|v| v.flatten())
    }

    pub fn set_mode_override(
        &self,
        ui_session_id: &str,
        value: Option<&str>,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().expect("db poisoned");
        conn.execute(
            "UPDATE sessions SET mode_override = ?2, updated_at = ?3 WHERE id = ?1",
            params![ui_session_id, value, now()],
        )?;
        Ok(())
    }

    /// 仅当会话标题仍是「未命名」时才写入。
    ///
    /// 这里只执行 SQL：哪些值算「未命名」、标题从哪来，都是业务判断，
    /// 由调用方（commands 层）决定 —— 见 docs/architecture.md §6.1。
    pub fn set_title_if_unnamed(
        &self,
        session_id: &str,
        title: &str,
        placeholders: &[&str],
    ) -> rusqlite::Result<usize> {
        let mut conn = self.conn.lock().expect("db poisoned");
        let tx = conn.transaction()?;
        let mut sql = String::from(
            "UPDATE sessions SET title = ?1 WHERE id = ?2 AND (title IS NULL OR title = ''",
        );
        let mut binds: Vec<String> = vec![title.to_string(), session_id.to_string()];
        for ph in placeholders.iter().filter(|p| !p.is_empty()) {
            sql.push_str(&format!(" OR title = ?{}", binds.len() + 1));
            binds.push((*ph).to_string());
        }
        sql.push(')');
        let n = tx.execute(&sql, rusqlite::params_from_iter(binds.iter()))?;
        tx.commit()?;
        Ok(n)
    }

    pub fn delete_session(&self, id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().expect("db poisoned");
        conn.execute("DELETE FROM sessions WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// 该 profile 最近绑定的 ACP 会话（重连时优先 load 它）
    pub fn last_acp_session(&self, profile_id: &str) -> rusqlite::Result<Option<String>> {
        let conn = self.conn.lock().expect("db poisoned");
        conn.query_row(
            "SELECT acp_session_id FROM sessions
             WHERE profile_id = ?1 AND acp_session_id IS NOT NULL
             ORDER BY updated_at DESC LIMIT 1",
            params![profile_id],
            |r| r.get(0),
        )
        .optional()
        .map(|v: Option<Option<String>>| v.flatten())
    }

    /* ---------------- messages ---------------- */

    pub fn append_messages(&self, session_id: &str, msgs: &[MessageInput]) -> rusqlite::Result<()> {
        if msgs.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn.lock().expect("db poisoned");
        let tx = conn.transaction()?;
        let base: i64 = tx.query_row(
            "SELECT COALESCE(MAX(seq), 0) FROM messages WHERE session_id = ?1",
            params![session_id],
            |r| r.get(0),
        )?;
        let ts = now();
        for (i, m) in msgs.iter().enumerate() {
            tx.execute(
                "INSERT INTO messages
                   (id, session_id, seq, role, kind, payload_json, created_at, author_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(id) DO UPDATE SET
                   payload_json = excluded.payload_json,
                   role = excluded.role,
                   kind = excluded.kind,
                   author_id = excluded.author_id",
                params![
                    m.id,
                    session_id,
                    base + i as i64 + 1,
                    m.role,
                    m.kind,
                    m.payload.to_string(),
                    ts,
                    m.author_id
                ],
            )?;
        }
        tx.execute(
            "UPDATE sessions SET updated_at = ?1 WHERE id = ?2",
            params![ts, session_id],
        )?;
        tx.commit()
    }

    /* ---------------- session_events（轨迹源数据） ---------------- */

    /// 追加轨迹事件。seq 由库按会话自增，保证顺序与重启后一致。
    ///
    /// 只做存储：哪些事件算轨迹、怎么截断，由 `trace` 模块决定（见 architecture §6.1）。
    pub fn append_events(
        &self,
        session_id: &str,
        events: &[EventInput],
    ) -> rusqlite::Result<usize> {
        if events.is_empty() {
            return Ok(0);
        }
        let mut conn = self.conn.lock().expect("db poisoned");
        let tx = conn.transaction()?;
        let mut seq: i64 = tx.query_row(
            "SELECT COALESCE(MAX(seq), 0) FROM session_events WHERE session_id = ?1",
            params![session_id],
            |r| r.get(0),
        )?;
        let at = now();
        for e in events {
            seq += 1;
            tx.execute(
                "INSERT INTO session_events
                   (id, session_id, turn_id, seq, at, author_id, kind, payload_json, source, truncated)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    format!("{session_id}-{seq}"),
                    session_id,
                    e.turn_id,
                    seq,
                    at,
                    e.author_id,
                    e.kind,
                    e.payload_json,
                    e.source,
                    e.truncated as i64,
                ],
            )?;
        }
        tx.commit()?;
        Ok(events.len())
    }

    pub fn load_events(&self, session_id: &str, limit: i64) -> rusqlite::Result<Vec<EventRow>> {
        let conn = self.conn.lock().expect("db poisoned");
        let mut stmt = conn.prepare(
            "SELECT id, seq, at, turn_id, author_id, kind, payload_json, source, truncated
               FROM session_events WHERE session_id = ?1
              ORDER BY seq DESC LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![session_id, limit], |r| {
                Ok(EventRow {
                    id: r.get(0)?,
                    seq: r.get(1)?,
                    at: r.get(2)?,
                    turn_id: r.get(3)?,
                    author_id: r.get(4)?,
                    kind: r.get(5)?,
                    payload_json: r.get(6)?,
                    source: r.get(7)?,
                    truncated: r.get::<_, i64>(8)? != 0,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn load_messages(&self, session_id: &str, limit: i64) -> rusqlite::Result<Vec<MessageRow>> {
        let conn = self.conn.lock().expect("db poisoned");
        let mut stmt = conn.prepare(
            "SELECT id, seq, role, kind, payload_json, created_at, author_id
             FROM messages WHERE session_id = ?1 ORDER BY seq DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![session_id, limit], |r| {
            let payload: String = r.get(4)?;
            Ok(MessageRow {
                id: r.get(0)?,
                seq: r.get(1)?,
                role: r.get(2)?,
                kind: r.get(3)?,
                payload: serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null),
                created_at: r.get(5)?,
                author_id: r.get(6)?,
            })
        })?;
        let mut out: Vec<MessageRow> = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        out.reverse();
        Ok(out)
    }

    /// 读一条元数据（发现结果缓存之类）。键值表的用途见 schema.sql 的 app_meta。
    pub fn meta_get(&self, key: &str) -> rusqlite::Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT value FROM app_meta WHERE key = ?1")?;
        let mut rows = stmt.query([key])?;
        rows.next()?.map(|r| r.get::<_, String>(0)).transpose()
    }

    /* ---------- 群聊成员（docs/group-chat.md） ---------- */

    /// 反查：某个 ACP 会话是哪个群成员的身份（一个会话至多一个身份，schema v4 的唯一约束）
    pub fn agent_user_by_acp_session(
        &self,
        acp_session_id: &str,
    ) -> rusqlite::Result<Option<AgentUserRow>> {
        let conn = self.conn.lock().expect("db poisoned");
        let mut stmt = conn.prepare(
            "SELECT id, profile_id, acp_session_id, name, handle, color, created_at
             FROM agent_users WHERE acp_session_id = ?1",
        )?;
        let mut rows = stmt.query(params![acp_session_id])?;
        match rows.next()? {
            Some(r) => Ok(Some(AgentUserRow {
                id: r.get(0)?,
                profile_id: r.get(1)?,
                acp_session_id: r.get(2)?,
                name: r.get(3)?,
                handle: r.get(4)?,
                color: r.get(5)?,
                created_at: r.get(6)?,
            })),
            None => Ok(None),
        }
    }

    pub fn list_agent_users(&self) -> rusqlite::Result<Vec<AgentUserRow>> {
        let conn = self.conn.lock().expect("db poisoned");
        let mut stmt = conn.prepare(
            "SELECT id, profile_id, acp_session_id, name, handle, color, created_at
             FROM agent_users ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(AgentUserRow {
                id: r.get(0)?,
                profile_id: r.get(1)?,
                acp_session_id: r.get(2)?,
                name: r.get(3)?,
                handle: r.get(4)?,
                color: r.get(5)?,
                created_at: r.get(6)?,
            })
        })?;
        rows.collect()
    }

    /// 新增或更新一个玩家。handle 与 (profile, acp_session) 都是唯一键 ——
    /// 冲突时把约束名带出来，让调用方能给出「这个 @ 已经被占了」这种准确的话。
    pub fn upsert_agent_user(&self, row: &AgentUserRow) -> rusqlite::Result<()> {
        let conn = self.conn.lock().expect("db poisoned");
        conn.execute(
            "INSERT INTO agent_users
               (id, profile_id, acp_session_id, name, handle, color, created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7)
             ON CONFLICT(id) DO UPDATE SET
               profile_id=excluded.profile_id, acp_session_id=excluded.acp_session_id,
               name=excluded.name, handle=excluded.handle, color=excluded.color",
            rusqlite::params![
                row.id,
                row.profile_id,
                row.acp_session_id,
                row.name,
                row.handle,
                row.color,
                row.created_at
            ],
        )?;
        Ok(())
    }

    pub fn delete_agent_user(&self, id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().expect("db poisoned");
        conn.execute("DELETE FROM agent_users WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn session_members(&self, session_id: &str) -> rusqlite::Result<Vec<AgentUserRow>> {
        let conn = self.conn.lock().expect("db poisoned");
        let mut stmt = conn.prepare(
            "SELECT u.id, u.profile_id, u.acp_session_id, u.name, u.handle, u.color, u.created_at
             FROM session_members m JOIN agent_users u ON u.id = m.user_id
             WHERE m.session_id = ?1 ORDER BY m.added_at ASC",
        )?;
        let rows = stmt.query_map([session_id], |r| {
            Ok(AgentUserRow {
                id: r.get(0)?,
                profile_id: r.get(1)?,
                acp_session_id: r.get(2)?,
                name: r.get(3)?,
                handle: r.get(4)?,
                color: r.get(5)?,
                created_at: r.get(6)?,
            })
        })?;
        rows.collect()
    }

    /// 幂等：重复拉同一个人进群不是错误
    pub fn add_member(&self, session_id: &str, user_id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().expect("db poisoned");
        conn.execute(
            "INSERT OR IGNORE INTO session_members (session_id, user_id, added_at)
             VALUES (?1, ?2, ?3)",
            rusqlite::params![session_id, user_id, now()],
        )?;
        Ok(())
    }

    pub fn remove_member(&self, session_id: &str, user_id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().expect("db poisoned");
        conn.execute(
            "DELETE FROM session_members WHERE session_id = ?1 AND user_id = ?2",
            rusqlite::params![session_id, user_id],
        )?;
        Ok(())
    }

    /// 按 handle 找成员（`@` 投递用）；大小写不敏感
    pub fn find_by_handle(&self, handle: &str) -> rusqlite::Result<Option<AgentUserRow>> {
        let conn = self.conn.lock().expect("db poisoned");
        let mut stmt = conn.prepare(
            "SELECT id, profile_id, acp_session_id, name, handle, color, created_at
             FROM agent_users WHERE handle = ?1 COLLATE NOCASE",
        )?;
        let mut rows = stmt.query([handle.trim_start_matches('@')])?;
        match rows.next()? {
            Some(r) => Ok(Some(AgentUserRow {
                id: r.get(0)?,
                profile_id: r.get(1)?,
                acp_session_id: r.get(2)?,
                name: r.get(3)?,
                handle: r.get(4)?,
                color: r.get(5)?,
                created_at: r.get(6)?,
            })),
            None => Ok(None),
        }
    }

    /// 写一条元数据（覆盖）。
    pub fn meta_set(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO app_meta(key, value) VALUES(?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [key, value],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> (Db, std::path::PathBuf) {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "sincearc-db-test-{}-{nanos}.db",
            std::process::id()
        ));
        (Db::open(&path).expect("open temp db"), path)
    }

    /// 加列之前的旧库：CREATE TABLE IF NOT EXISTS 不会补列，
    /// 所以 open() 必须靠 ensure_column 补齐，而且不能顺手把会话清掉。
    #[test]
    fn old_db_gains_mode_columns_without_losing_sessions() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "sincearc-db-migrate-{}-{nanos}.db",
            std::process::id()
        ));

        {
            let conn = Connection::open(&path).expect("raw open");
            // 关键：保留 acp_session_id（否则会被判定为需要整表重建），但两列都还没有
            conn.execute_batch(
                "CREATE TABLE profiles (
                   id TEXT PRIMARY KEY, name TEXT NOT NULL,
                   launch_kind TEXT NOT NULL CHECK (launch_kind IN ('local','wsl','ssh')),
                   distro TEXT, shell TEXT, program TEXT NOT NULL,
                   args_json TEXT NOT NULL DEFAULT '[]', env_json TEXT NOT NULL DEFAULT '{}',
                   default_cwd TEXT NOT NULL,
                   ssh_host TEXT, ssh_port INTEGER, ssh_user TEXT, ssh_auth TEXT, ssh_key_path TEXT,
                   created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
                 CREATE TABLE sessions (
                   id TEXT PRIMARY KEY, acp_session_id TEXT,
                   profile_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,
                   title TEXT NOT NULL DEFAULT '新会话', cwd TEXT NOT NULL DEFAULT '',
                   created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
                 INSERT INTO sessions (id, acp_session_id, title, cwd, created_at, updated_at)
                   VALUES ('s-old', 'acp-old', '老会话', '/tmp', 1, 1);",
            )
            .expect("seed old schema");
        }

        let db = Db::open(&path).expect("迁移后应当能打开");

        let rows = db.list_sessions(None).expect("list");
        assert_eq!(rows.len(), 1, "旧会话不该被清掉");
        assert_eq!(rows[0].id, "s-old");
        assert_eq!(rows[0].mode_override, None);

        db.set_mode_override("s-old", Some("dont_ask"))
            .expect("写入覆盖值");
        assert_eq!(
            db.mode_override("s-old").expect("读回").as_deref(),
            Some("dont_ask")
        );

        db.set_mode_override("s-old", None).expect("改回跟随");
        assert_eq!(db.mode_override("s-old").expect("读回"), None);

        std::fs::remove_file(&path).ok();
    }

    fn user(id: &str, handle: &str, session: &str) -> AgentUserRow {
        AgentUserRow {
            id: id.into(),
            profile_id: "p1".into(),
            acp_session_id: session.into(),
            name: format!("玩家{id}"),
            handle: handle.into(),
            color: "#8ab4f8".into(),
            created_at: 1,
        }
    }

    #[test]
    fn agent_user_的_handle_大小写不敏感且唯一() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).unwrap();
        db.upsert_agent_user(&user("u1", "backend", "s-acp-1"))
            .unwrap();
        // 大小写不同不算另一个人：@BackEnd 和 @backend 会打给同一个人
        let err = db
            .upsert_agent_user(&user("u2", "BackEnd", "s-acp-2"))
            .unwrap_err();
        assert!(err.to_string().contains("handle"), "got: {err}");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn 同一连接的同一个会话只能是一个玩家() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).unwrap();
        db.upsert_agent_user(&user("u1", "a", "s-acp-1")).unwrap();
        // 两个人其实是同一个会话 → 群聊语义当场崩，必须拒绝
        let err = db
            .upsert_agent_user(&user("u2", "b", "s-acp-1"))
            .unwrap_err();
        assert!(err.to_string().contains("acp_session_id"), "got: {err}");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn 群成员可以重复拉且能移出() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).unwrap();
        let s = SessionRow {
            id: "s1".into(),
            acp_session_id: None,
            mode_override: None,
            profile_id: Some("p1".into()),
            title: "群".into(),
            cwd: "/tmp".into(),
            created_at: 1,
            updated_at: 1,
        };
        db.upsert_session(&s).unwrap();
        db.upsert_agent_user(&user("u1", "a", "s-acp-1")).unwrap();

        db.add_member("s1", "u1").unwrap();
        db.add_member("s1", "u1").unwrap(); // 幂等：重复拉不是错误
        assert_eq!(db.session_members("s1").unwrap().len(), 1);

        db.remove_member("s1", "u1").unwrap();
        assert!(db.session_members("s1").unwrap().is_empty());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn 消息带作者_读回来还在() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).unwrap();
        let s = SessionRow {
            id: "s1".into(),
            acp_session_id: None,
            mode_override: None,
            profile_id: Some("p1".into()),
            title: "群".into(),
            cwd: "/tmp".into(),
            created_at: 1,
            updated_at: 1,
        };
        db.upsert_session(&s).unwrap();
        db.append_messages(
            "s1",
            &[MessageInput {
                id: "m1".into(),
                role: "player".into(),
                kind: "text".into(),
                payload: serde_json::json!({"text": "在"}),
                author_id: Some("u1".into()),
            }],
        )
        .unwrap();
        let rows = db.load_messages("s1", 10).unwrap();
        assert_eq!(rows[0].author_id.as_deref(), Some("u1"));
        let _ = std::fs::remove_file(path);
    }

    fn sample() -> ProfileDto {
        ProfileDto {
            id: "p1".into(),
            name: "Hermes (WSL)".into(),
            launch: "wsl".into(),
            program: "hermes".into(),
            args: vec!["acp".into()],
            cwd: "/mnt/c/source/sincearc".into(),
            default_mode: None,
            distro: Some("fedora".into()),
            shell: Some("zsh".into()),
            ssh_host: None,
            ssh_port: None,
            ssh_user: None,
            ssh_auth: None,
            ssh_key_path: None,
            ssh_password: Some("must-not-persist".into()),
        }
    }

    fn session(id: &str, acp: Option<&str>) -> SessionRow {
        SessionRow {
            id: id.into(),
            acp_session_id: acp.map(|s| s.to_string()),
            mode_override: None,
            profile_id: Some("p1".into()),
            title: "新会话".into(),
            cwd: "/mnt/c/source/sincearc".into(),
            created_at: now(),
            updated_at: now(),
        }
    }

    #[test]
    fn profiles_round_trip_and_passwords_are_dropped() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).expect("save");
        let loaded = db.load_profiles().expect("load");
        assert_eq!(loaded.len(), 1);
        assert!(loaded[0].ssh_password.is_none());
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn sessions_are_listed_newest_first_and_cascade_on_profile_delete() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).expect("save");
        db.upsert_session(&session("s-old", Some("acp-1")))
            .expect("s1");
        std::thread::sleep(std::time::Duration::from_millis(1100));
        db.upsert_session(&session("s-new", None)).expect("s2");

        let list = db.list_sessions(None).expect("list");
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, "s-new", "最近的排前面");

        // 删配置 -> 它的会话一起没了
        db.save_profiles(&[]).expect("clear");
        assert!(db.list_sessions(None).expect("list").is_empty());
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn binding_an_acp_session_survives_a_null_upsert() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).expect("save");
        db.upsert_session(&session("s-1", None)).expect("insert");
        db.bind_acp_session("s-1", "local-abc").expect("bind");
        // 之后再 upsert 一次（acp 为空）不能把绑定冲掉
        db.upsert_session(&session("s-1", None)).expect("upsert");
        let list = db.list_sessions(None).expect("list");
        assert_eq!(list[0].acp_session_id.as_deref(), Some("local-abc"));
        assert_eq!(
            db.last_acp_session("p1").expect("last").as_deref(),
            Some("local-abc")
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn first_user_message_becomes_the_session_title() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).expect("save");
        db.upsert_session(&session("s-1", None)).expect("insert");

        let user = |id: &str, text: &str| MessageInput {
            id: id.into(),
            author_id: None,
            role: "user".into(),
            kind: "text".into(),
            payload: serde_json::json!({ "id": id, "text": text }),
        };
        db.append_messages("s-1", &[user("u1", "第一行标题\n第二行不要")])
            .expect("a");
        // db 不知道「标题该怎么来」：调用方给什么就写什么（业务规则在 commands 层）
        let n = db
            .set_title_if_unnamed("s-1", "第一行标题", &["新会话"])
            .expect("title");
        assert_eq!(n, 1, "占位名可被覆盖");
        assert_eq!(db.list_sessions(None).expect("list")[0].title, "第一行标题");

        // 已有真实标题就不再覆盖
        let n2 = db
            .set_title_if_unnamed("s-1", "第二条完全不同的话", &["新会话"])
            .expect("title2");
        assert_eq!(n2, 0, "非占位名不许改");

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn messages_append_in_order_and_reload_ascending() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).expect("save");
        db.upsert_session(&session("s-1", None)).expect("insert");

        let mk = |id: &str, text: &str| MessageInput {
            id: id.into(),
            author_id: None,
            role: "player".into(),
            kind: "text".into(),
            payload: serde_json::json!({ "id": id, "text": text }),
        };
        db.append_messages("s-1", &[mk("m1", "第一句")]).expect("a");
        db.append_messages("s-1", &[mk("m2", "第二句")]).expect("b");

        // 同一条再写一次（流式定稿会重复调用），不应该多出一行
        db.append_messages("s-1", &[mk("m2", "第二句（更新）")])
            .expect("b2");

        let rows = db.load_messages("s-1", 50).expect("load");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].seq, 1);
        assert_eq!(rows[1].seq, 2);
        assert_eq!(rows[1].payload["text"], "第二句（更新）");

        // 会话被删 -> 消息跟着走
        db.delete_session("s-1").expect("del");
        assert!(db.load_messages("s-1", 50).expect("load").is_empty());
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn events_are_appended_in_order_and_die_with_the_session() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).expect("save");
        db.upsert_session(&session("s-1", None)).expect("insert");

        let ev = |kind: &str, turn: &str| EventInput {
            turn_id: turn.into(),
            author_id: None,
            kind: kind.into(),
            payload_json: r#"{"text":"x"}"#.into(),
            source: "live".into(),
            truncated: false,
        };
        db.append_events("s-1", &[ev("thought", "t1")]).expect("e1");
        db.append_events(
            "s-1",
            &[ev("tool_call", "t1"), ev("permission", "t2")],
        )
        .expect("e2");

        let rows = db.load_events("s-1", 50).expect("load");
        // 倒序返回：最新的在前
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].seq, 3);
        assert_eq!(rows[0].kind, "permission");
        assert_eq!(rows[0].turn_id, "t2");
        assert_eq!(rows[2].seq, 1);
        assert_eq!(rows[2].kind, "thought");

        // 删会话要连轨迹一起删：否则库里留下没人能看的孤儿行
        db.delete_session("s-1").expect("delete");
        assert!(db.load_events("s-1", 50).expect("load2").is_empty());

        std::fs::remove_file(&path).ok();
    }

}
