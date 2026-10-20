//! 本地持久化（SQLite）。
//!
//! 存三类东西：
//! - `profiles`：agent 连接配置。**SSH 密码不入库** —— 它本来只在内存里过一手，
//!   落盘就等于把凭据写进明文文件，与既定口径冲突。
//! - `workspaces`：agent 侧的工作目录（`fs/*` 回调的沙箱根）。当前每个 profile
//!   自动对应一个，路径取 profile 的 cwd。
//! - `sessions`：ACP 会话 id 与其归属。作用是重连时优先 `session/load` 复用，
//!   而不是每次都 `session/new` —— 后者会在 agent 侧堆一串再也不会被打开的会话。
//!
//! `messages` / `permission_rules` 表已建但未接线（E4 用）。

use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};

use crate::commands::ProfileDto;

pub const SCHEMA: &str = include_str!("schema.sql");

pub struct Db {
    conn: Mutex<Connection>,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn load_profiles(&self) -> rusqlite::Result<Vec<ProfileDto>> {
        let conn = self.conn.lock().expect("db poisoned");
        let mut stmt = conn.prepare(
            "SELECT id, name, launch_kind, program, args_json, default_cwd,
                    distro, shell, ssh_host, ssh_port, ssh_user, ssh_auth, ssh_key_path
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

    /// 整表对齐：列表里的 upsert，不在列表里的删掉（workspace / session 由外键级联）。
    /// 自用工具、配置数量个位数，全量覆盖比维护增量简单，也不会留下僵尸配置。
    pub fn save_profiles(&self, list: &[ProfileDto]) -> rusqlite::Result<()> {
        let mut conn = self.conn.lock().expect("db poisoned");
        let tx = conn.transaction()?;
        let ts = now();

        for p in list {
            let args = serde_json::to_string(&p.args).unwrap_or_else(|_| "[]".into());
            tx.execute(
                "INSERT INTO profiles
                   (id, name, launch_kind, distro, shell, program, args_json, env_json,
                    default_cwd, ssh_host, ssh_port, ssh_user, ssh_auth, ssh_key_path,
                    created_at, updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,'{}',?8,?9,?10,?11,?12,?13,?14,?14)
                 ON CONFLICT(id) DO UPDATE SET
                   name=excluded.name, launch_kind=excluded.launch_kind,
                   distro=excluded.distro, shell=excluded.shell,
                   program=excluded.program, args_json=excluded.args_json,
                   default_cwd=excluded.default_cwd, ssh_host=excluded.ssh_host,
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

        // 先找出这次被删掉的配置
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
            // workspaces 对 profiles 是 RESTRICT（防误删沙箱根），所以删除顺序必须显式：
            // 先删该配置的工作区（sessions 随之 CASCADE），再删配置本身。
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

    /// 每个 profile 一个默认 workspace，id 由 profile 派生（确定性，不重复建）
    fn ensure_workspace(
        &self,
        tx: &rusqlite::Transaction<'_>,
        profile_id: &str,
        cwd: &str,
    ) -> rusqlite::Result<String> {
        let id = format!("ws-{profile_id}");
        let roots = serde_json::to_string(&[cwd]).unwrap_or_else(|_| "[]".into());
        tx.execute(
            "INSERT INTO workspaces (id, name, profile_id, roots_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO NOTHING",
            params![id, profile_id, profile_id, roots, now()],
        )?;
        Ok(id)
    }

    /// 记一次会话：新建的插入，复用的一次刷新 updated_at
    pub fn remember_session(
        &self,
        session_id: &str,
        profile_id: &str,
        cwd: &str,
    ) -> rusqlite::Result<()> {
        let mut conn = self.conn.lock().expect("db poisoned");
        let tx = conn.transaction()?;
        let ws = self.ensure_workspace(&tx, profile_id, cwd)?;
        let ts = now();
        tx.execute(
            "INSERT INTO sessions (id, workspace_id, cwd, state, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'active', ?4, ?4)
             ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at",
            params![session_id, ws, cwd, ts],
        )?;
        tx.commit()
    }

    /// 该 profile 最近用过的会话（重连时优先 load 它）
    pub fn last_session(&self, profile_id: &str) -> rusqlite::Result<Option<String>> {
        let conn = self.conn.lock().expect("db poisoned");
        conn.query_row(
            "SELECT s.id FROM sessions s
             JOIN workspaces w ON w.id = s.workspace_id
             WHERE w.profile_id = ?1 AND s.state = 'active'
             ORDER BY s.updated_at DESC LIMIT 1",
            params![profile_id],
            |r| r.get(0),
        )
        .optional()
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

    fn sample() -> ProfileDto {
        ProfileDto {
            id: "p-hermes-wsl".into(),
            name: "Hermes (WSL)".into(),
            launch: "wsl".into(),
            program: "hermes".into(),
            args: vec!["acp".into()],
            cwd: "/mnt/c/source/sincearc".into(),
            distro: Some("fedora".into()),
            shell: Some("zsh".into()),
            ssh_host: None,
            ssh_port: None,
            ssh_user: None,
            ssh_auth: None,
            ssh_key_path: None,
            ssh_password: Some("should-never-be-stored".into()),
        }
    }

    #[test]
    fn profiles_survive_a_round_trip_and_passwords_are_dropped() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).expect("save");

        let loaded = db.load_profiles().expect("load");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].name, "Hermes (WSL)");
        assert_eq!(loaded[0].cwd, "/mnt/c/source/sincearc");
        assert_eq!(loaded[0].args, vec!["acp".to_string()]);
        // 密码不落盘：写进去的值读回来必须没有
        assert!(loaded[0].ssh_password.is_none());

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn removing_a_profile_cascades_its_sessions() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).expect("save");
        db.remember_session("sess-1", "p-hermes-wsl", "/mnt/c/source/sincearc")
            .expect("remember");
        assert_eq!(
            db.last_session("p-hermes-wsl").expect("last").as_deref(),
            Some("sess-1")
        );

        // 界面上删掉这条配置 -> 它的会话记账一并消失，不留孤儿
        db.save_profiles(&[]).expect("clear");
        assert!(db.last_session("p-hermes-wsl").expect("last").is_none());

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn session_reuse_picks_the_most_recent_one() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).expect("save");
        db.remember_session("old", "p-hermes-wsl", "/a").expect("a");
        std::thread::sleep(std::time::Duration::from_millis(1100));
        db.remember_session("new", "p-hermes-wsl", "/b").expect("b");
        assert_eq!(
            db.last_session("p-hermes-wsl").expect("last").as_deref(),
            Some("new")
        );
        std::fs::remove_file(&path).ok();
    }
}
