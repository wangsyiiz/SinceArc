//! 项目落库：远端身份（repos）与本地副本（local_repos）。
//!
//! 纯数据层，不依赖 tauri。主键是 `(host, owner, name)` 的远端身份，
//! 本地路径只是它的一份副本（docs/gh.md §2.2）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::{params, OptionalExtension};

use super::{now, Db, DbError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoRow {
    pub id: String,
    pub host: String,
    pub owner: String,
    pub name: String,
    pub default_branch: Option<String>,
    pub pinned_at: Option<i64>,
    pub last_used_at: Option<i64>,
    pub locals: Vec<LocalRepoRow>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalRepoRow {
    pub id: String,
    pub path: String,
    pub host_kind: String,
    pub last_used_at: Option<i64>,
}

static NEXT_ID: AtomicU64 = AtomicU64::new(0);

fn new_id(prefix: &str) -> String {
    let seq = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{}-{seq}", now())
}

fn normalize_host(host: &str) -> String {
    host.trim().to_ascii_lowercase()
}

impl Db {
    /// 按 `(host, owner, name)` upsert；存在则只补 default_branch（非 None 时才覆盖）。
    pub fn upsert_repo(
        &self,
        host: &str,
        owner: &str,
        name: &str,
        default_branch: Option<&str>,
    ) -> Result<String, DbError> {
        let host = normalize_host(host);
        let owner = owner.trim();
        let name = name.trim();
        let conn = self.conn.lock().expect("db poisoned");
        conn.execute(
            "INSERT INTO repos
               (id, host, owner, name, default_branch, pinned_at, created_at, last_used_at)
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, NULL)
             ON CONFLICT(host, owner, name) DO UPDATE SET
               default_branch = COALESCE(excluded.default_branch, repos.default_branch)",
            params![new_id("repo"), host, owner, name, default_branch, now()],
        )?;
        let id = conn.query_row(
            "SELECT id FROM repos WHERE host = ?1 AND owner = ?2 AND name = ?3",
            params![host, owner, name],
            |row| row.get(0),
        )?;
        Ok(id)
    }

    /// 同一路径重复添加要幂等（UNIQUE(path)）：已存在则更新 last_used_at 并返回原 id。
    /// 返回 true 表示这次新增了一行。
    pub fn add_local_repo(
        &self,
        repo_id: &str,
        path: &str,
        host_kind: &str,
    ) -> Result<bool, DbError> {
        let conn = self.conn.lock().expect("db poisoned");
        let at = now();
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM local_repos WHERE path = ?1",
                [path],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(id) = existing {
            conn.execute(
                "UPDATE local_repos SET last_used_at = ?1 WHERE id = ?2",
                params![at, id],
            )?;
            return Ok(false);
        }

        conn.execute(
            "INSERT INTO local_repos (id, repo_id, path, host_kind, added_at, last_used_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![new_id("local"), repo_id, path, host_kind, at],
        )?;
        Ok(true)
    }

    pub fn list_repos(&self) -> Result<Vec<RepoRow>, DbError> {
        let conn = self.conn.lock().expect("db poisoned");
        let mut stmt = conn.prepare(
            "SELECT id, host, owner, name, default_branch, pinned_at, last_used_at
               FROM repos
              ORDER BY (pinned_at IS NULL), pinned_at DESC,
                       (last_used_at IS NULL), last_used_at DESC,
                       name COLLATE NOCASE ASC, id ASC",
        )?;
        let mut repos: Vec<RepoRow> = stmt
            .query_map([], |row| {
                Ok(RepoRow {
                    id: row.get(0)?,
                    host: row.get(1)?,
                    owner: row.get(2)?,
                    name: row.get(3)?,
                    default_branch: row.get(4)?,
                    pinned_at: row.get(5)?,
                    last_used_at: row.get(6)?,
                    locals: Vec::new(),
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        drop(stmt);

        let mut local_stmt = conn.prepare(
            "SELECT id, repo_id, path, host_kind, last_used_at
               FROM local_repos
              ORDER BY (last_used_at IS NULL), last_used_at DESC, added_at ASC, id ASC",
        )?;
        let mut locals: HashMap<String, Vec<LocalRepoRow>> = HashMap::new();
        let rows = local_stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                LocalRepoRow {
                    id: row.get(0)?,
                    path: row.get(2)?,
                    host_kind: row.get(3)?,
                    last_used_at: row.get(4)?,
                },
            ))
        })?;
        for row in rows {
            let (repo_id, local) = row?;
            locals.entry(repo_id).or_default().push(local);
        }

        for repo in &mut repos {
            repo.locals = locals.remove(&repo.id).unwrap_or_default();
        }
        Ok(repos)
    }

    pub fn set_repo_pinned(&self, repo_id: &str, pinned: bool) -> Result<(), DbError> {
        let conn = self.conn.lock().expect("db poisoned");
        if pinned {
            conn.execute(
                "UPDATE repos SET pinned_at = COALESCE(pinned_at, ?1) WHERE id = ?2",
                params![now(), repo_id],
            )?;
        } else {
            conn.execute("UPDATE repos SET pinned_at = NULL WHERE id = ?1", [repo_id])?;
        }
        Ok(())
    }

    /// 只删本地副本，不级联删 repo：pin 与远端身份要留下来（「只看不干」仍需要它）。
    pub fn remove_local_repo(&self, path: &str) -> Result<bool, DbError> {
        let conn = self.conn.lock().expect("db poisoned");
        let removed = conn.execute("DELETE FROM local_repos WHERE path = ?1", [path])?;
        Ok(removed > 0)
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    fn temp_db() -> (Db, PathBuf) {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "sincearc-repos-test-{}-{nanos}.db",
            std::process::id()
        ));
        let db = Db::open(&path).expect("open temp db");
        (db, path)
    }

    #[test]
    fn upsert_repo_is_idempotent_and_only_fills_default_branch() {
        let (db, _path) = temp_db();
        let first = db
            .upsert_repo("GitHub.com", "acme", "api", None)
            .unwrap();
        let second = db
            .upsert_repo("github.com", "acme", "api", Some("main"))
            .unwrap();
        let third = db.upsert_repo("github.com", "acme", "api", None).unwrap();

        assert_eq!(first, second);
        assert_eq!(second, third);
        let repos = db.list_repos().unwrap();
        assert_eq!(repos.len(), 1);
        assert_eq!(repos[0].default_branch.as_deref(), Some("main"));
    }

    #[test]
    fn identity_is_unique_per_host_owner_name() {
        let (db, _path) = temp_db();
        db.upsert_repo("github.com", "acme", "api", None)
            .unwrap();
        db.upsert_repo("github.com", "acme", "api", None)
            .unwrap();
        db.upsert_repo("github.com", "acme", "web", None)
            .unwrap();
        db.upsert_repo("gitlab.com", "acme", "api", None)
            .unwrap();

        let repos = db.list_repos().unwrap();
        assert_eq!(repos.len(), 3);
    }

    #[test]
    fn add_local_repo_is_idempotent_by_path() {
        let (db, _path) = temp_db();
        let repo = db.upsert_repo("github.com", "acme", "api", None).unwrap();

        assert!(db
            .add_local_repo(&repo, "/home/me/api", "local")
            .unwrap());
        assert!(!db
            .add_local_repo(&repo, "/home/me/api", "local")
            .unwrap());

        let repos = db.list_repos().unwrap();
        assert_eq!(repos[0].locals.len(), 1);
        assert!(repos[0].locals[0].last_used_at.is_some());
    }

    #[test]
    fn pin_round_trips() {
        let (db, _path) = temp_db();
        let repo = db.upsert_repo("github.com", "acme", "api", None).unwrap();

        db.set_repo_pinned(&repo, true).unwrap();
        assert!(db.list_repos().unwrap()[0].pinned_at.is_some());

        db.set_repo_pinned(&repo, false).unwrap();
        assert!(db.list_repos().unwrap()[0].pinned_at.is_none());
    }

    #[test]
    fn list_repos_carries_locals() {
        let (db, _path) = temp_db();
        let repo = db.upsert_repo("github.com", "acme", "api", None).unwrap();
        db.add_local_repo(&repo, "/home/me/api", "wsl:Ubuntu")
            .unwrap();

        let repos = db.list_repos().unwrap();
        assert_eq!(repos.len(), 1);
        assert_eq!(repos[0].locals.len(), 1);
        assert_eq!(repos[0].locals[0].path, "/home/me/api");
        assert_eq!(repos[0].locals[0].host_kind, "wsl:Ubuntu");
    }

    #[test]
    fn removing_last_local_keeps_repo() {
        let (db, _path) = temp_db();
        let repo = db.upsert_repo("github.com", "acme", "api", None).unwrap();
        db.add_local_repo(&repo, "/home/me/api", "local")
            .unwrap();
        db.set_repo_pinned(&repo, true).unwrap();

        assert!(db.remove_local_repo("/home/me/api").unwrap());
        assert!(!db.remove_local_repo("/home/me/api").unwrap());

        let repos = db.list_repos().unwrap();
        assert_eq!(repos.len(), 1);
        assert!(repos[0].locals.is_empty());
        assert!(repos[0].pinned_at.is_some());
    }
}
