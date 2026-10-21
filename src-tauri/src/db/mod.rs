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
const SCHEMA_VERSION: i64 = 3;

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRow {
    pub id: String,
    pub seq: i64,
    pub role: String,
    pub kind: String,
    /// 原始消息对象（前端 `Message` 的形状），不做有损转换
    pub payload: serde_json::Value,
    pub created_at: i64,
}

/// 写入用：seq 由后端按 MAX+1 分配，前端不需要知道
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageInput {
    pub id: String,
    pub role: String,
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
                "INSERT INTO messages (id, session_id, seq, role, kind, payload_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(id) DO UPDATE SET
                   payload_json = excluded.payload_json,
                   role = excluded.role,
                   kind = excluded.kind",
                params![
                    m.id,
                    session_id,
                    base + i as i64 + 1,
                    m.role,
                    m.kind,
                    m.payload.to_string(),
                    ts
                ],
            )?;
        }
        tx.execute(
            "UPDATE sessions SET updated_at = ?1 WHERE id = ?2",
            params![ts, session_id],
        )?;
        tx.commit()
    }

    /// 最近 limit 条，按 seq 升序返回
    pub fn load_messages(&self, session_id: &str, limit: i64) -> rusqlite::Result<Vec<MessageRow>> {
        let conn = self.conn.lock().expect("db poisoned");
        let mut stmt = conn.prepare(
            "SELECT id, seq, role, kind, payload_json, created_at
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
            })
        })?;
        let mut out: Vec<MessageRow> = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        out.reverse();
        Ok(out)
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
    fn messages_append_in_order_and_reload_ascending() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).expect("save");
        db.upsert_session(&session("s-1", None)).expect("insert");

        let mk = |id: &str, text: &str| MessageInput {
            id: id.into(),
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
}
