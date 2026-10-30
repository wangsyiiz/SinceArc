//! 项目命令层：远端身份与本地副本的读写。
//!
//! 这里只做路径归一、身份解析与 DTO 映射；持久化在 `db::repos`，
//! `.git/config` 解析复用 `gh::repo`（不启动进程）。

use std::collections::BTreeMap;

use serde::Serialize;
use tauri::State;

use crate::commands::CmdError;
use crate::db::repos::{LocalRepoRow, RepoRow};
use crate::db::Db;
use crate::gh::to_cmd_error;
use crate::gh::repo::resolve_repo;
use crate::state::AppState;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct LocalRepoDto {
    pub id: String,
    pub path: String,
    pub host_kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct RepoDto {
    pub id: String,
    pub host: String,
    pub owner: String,
    pub name: String,
    pub default_branch: Option<String>,
    pub pinned: bool,
    #[ts(type = "number | null")]
    pub last_used_at: Option<i64>,
    pub locals: Vec<LocalRepoDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct RepoListDto {
    pub items: Vec<RepoDto>,
}

impl From<LocalRepoRow> for LocalRepoDto {
    fn from(row: LocalRepoRow) -> Self {
        Self {
            id: row.id,
            path: row.path,
            host_kind: row.host_kind,
        }
    }
}

impl From<RepoRow> for RepoDto {
    fn from(row: RepoRow) -> Self {
        Self {
            id: row.id,
            host: row.host,
            owner: row.owner,
            name: row.name,
            default_branch: row.default_branch,
            pinned: row.pinned_at.is_some(),
            last_used_at: row.last_used_at,
            locals: row.locals.into_iter().map(LocalRepoDto::from).collect(),
        }
    }
}

/// 去掉尾部分隔符、统一 Windows 反斜杠。盘符根（`C:\`）保留成 `C:/`。
/// 与前端 `src/lib/repo-path.ts` 的纯函数保持同一口径。
fn normalize_local_path(input: &str) -> String {
    let raw = input.trim().replace('\\', "/");
    if raw.is_empty() {
        return raw;
    }
    let bytes = raw.as_bytes();
    let drive_root = raw.len() >= 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && raw[2..].chars().all(|c| c == '/');
    if drive_root {
        return format!("{}:/", &raw[..1]);
    }
    let mut out = raw;
    while out.len() > 1 && out.ends_with('/') {
        out.pop();
    }
    out
}

fn db_failed(key: &'static str, action: &str, error: impl std::fmt::Display) -> CmdError {
    let detail = error.to_string();
    CmdError::keyed_with(
        50000,
        key,
        format!("{action}：{detail}"),
        BTreeMap::from([("detail".to_string(), detail)]),
    )
}

fn repo_dto(db: &Db, repo_id: &str) -> Result<RepoDto, CmdError> {
    db.list_repos()
        .map_err(|error| db_failed("err.repos.loadFailed", "读取项目失败", error))?
        .into_iter()
        .find(|row| row.id == repo_id)
        .map(RepoDto::from)
        .ok_or_else(|| {
            CmdError::keyed_with(
                50000,
                "err.repos.notFound",
                format!("项目不存在：{repo_id}"),
                BTreeMap::from([("repoId".to_string(), repo_id.to_string())]),
            )
        })
}

fn required(value: &str, field: &'static str, key: &'static str) -> Result<String, CmdError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(CmdError::keyed_with(
            50000,
            key,
            format!("{field} 不能为空"),
            BTreeMap::from([(field.to_string(), value.to_string())]),
        ));
    }
    Ok(trimmed.to_string())
}

#[tauri::command]
pub fn repos_list(state: State<'_, AppState>) -> Result<RepoListDto, CmdError> {
    let items: Vec<RepoDto> = state
        .db
        .list_repos()
        .map_err(|error| db_failed("err.repos.loadFailed", "读取项目失败", error))?
        .into_iter()
        .map(RepoDto::from)
        .collect();
    tracing::debug!(target: "sincearc::repos", count = items.len(), "repos list");
    Ok(RepoListDto { items })
}

/// 本地目录 → 远端身份 → repos / local_repos。解析失败原样映射 GhError，
/// 「不是 git 仓库」与「没有 remote」都由 gh 的错误码与 key 区分。
#[tauri::command]
pub fn repos_add_local(state: State<'_, AppState>, path: String) -> Result<RepoDto, CmdError> {
    let path = normalize_local_path(&path);
    if path.is_empty() {
        return Err(CmdError::keyed_with(
            50000,
            "err.repos.pathRequired",
            "仓库路径不能为空",
            BTreeMap::from([("path".to_string(), path)]),
        ));
    }

    let repo = resolve_repo(&path).map_err(|error| {
        tracing::warn!(
            target: "sincearc::repos",
            code = error.code(),
            error = ?error,
            path = %path,
            "repos add local: resolve failed"
        );
        to_cmd_error(error)
    })?;
    let host = repo.host.unwrap_or_default();
    let repo_id = state
        .db
        .upsert_repo(&host, &repo.owner, &repo.name, None)
        .map_err(|error| db_failed("err.repos.saveFailed", "保存项目失败", error))?;
    let created = state
        .db
        .add_local_repo(&repo_id, &path, "local")
        .map_err(|error| db_failed("err.repos.saveFailed", "保存本地副本失败", error))?;

    tracing::info!(
        target: "sincearc::repos",
        repo = %repo_id,
        host = %host,
        owner = %repo.owner,
        name = %repo.name,
        path = %path,
        created,
        "repos add local"
    );
    state
        .db
        .list_repos()
        .map_err(|error| db_failed("err.repos.loadFailed", "读取项目失败", error))?
        .into_iter()
        .find(|row| row.locals.iter().any(|local| local.path == path))
        .map(RepoDto::from)
        .ok_or_else(|| {
            CmdError::keyed_with(
                50000,
                "err.repos.notFound",
                format!("本地副本没有落库：{path}"),
                BTreeMap::from([("path".to_string(), path.clone())]),
            )
        })
}

/// 「只看不干」：只写远端身份，不写 local_repos。
#[tauri::command]
pub fn repos_add_remote(
    state: State<'_, AppState>,
    host: String,
    owner: String,
    name: String,
    default_branch: Option<String>,
) -> Result<RepoDto, CmdError> {
    let owner = required(&owner, "owner", "err.repos.ownerRequired")?;
    let name = required(&name, "name", "err.repos.nameRequired")?;
    let host = host.trim().to_ascii_lowercase();
    let default_branch = default_branch
        .map(|branch| branch.trim().to_string())
        .filter(|branch| !branch.is_empty());

    let repo_id = state
        .db
        .upsert_repo(&host, &owner, &name, default_branch.as_deref())
        .map_err(|error| db_failed("err.repos.saveFailed", "保存项目失败", error))?;
    tracing::info!(
        target: "sincearc::repos",
        repo = %repo_id,
        host = %host,
        owner = %owner,
        name = %name,
        "repos add remote"
    );
    repo_dto(&state.db, &repo_id)
}

#[tauri::command]
pub fn repos_pin(
    state: State<'_, AppState>,
    repo_id: String,
    pinned: bool,
) -> Result<(), CmdError> {
    state
        .db
        .set_repo_pinned(&repo_id, pinned)
        .map_err(|error| db_failed("err.repos.pinFailed", "更新 pin 失败", error))?;
    tracing::info!(target: "sincearc::repos", repo = %repo_id, pinned, "repos pin");
    Ok(())
}

#[tauri::command]
pub fn repos_remove_local(state: State<'_, AppState>, path: String) -> Result<(), CmdError> {
    let path = normalize_local_path(&path);
    let removed = state
        .db
        .remove_local_repo(&path)
        .map_err(|error| db_failed("err.repos.removeFailed", "删除本地副本失败", error))?;
    tracing::info!(target: "sincearc::repos", path = %path, removed, "repos remove local");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::normalize_local_path;

    #[test]
    fn normalizes_windows_separators_and_trailing_slashes() {
        assert_eq!(
            normalize_local_path(r"C:\source\sincearc\\"),
            "C:/source/sincearc"
        );
        assert_eq!(normalize_local_path("/home/me/repo/"), "/home/me/repo");
        assert_eq!(normalize_local_path("/"), "/");
        assert_eq!(normalize_local_path(r"C:\"), "C:/");
        assert_eq!(normalize_local_path(r"  C:\src\app  "), "C:/src/app");
    }
}
