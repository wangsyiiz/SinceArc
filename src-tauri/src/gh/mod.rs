//! gh 命令层：DTO 映射与错误码/文案映射。

pub mod cli;
pub mod model;
pub mod service;

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::CmdError;

use self::model::{
    Author, CheckState, GhCli, GhError, GhStatus, PrState, PrStateView, PullRequest, RepoRef,
};
use self::service::GhService;

pub struct GhState(pub GhService);

impl GhState {
    pub fn new(cli: Arc<dyn GhCli>) -> Self {
        Self(GhService::new(cli))
    }
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct GhStatusDto {
    pub available: bool,
    pub version: Option<String>,
    pub logged_in: bool,
    pub gh_path: Option<String>,
    pub host: Option<String>,
    pub cwd_ok: bool,
}

impl From<GhStatus> for GhStatusDto {
    fn from(status: GhStatus) -> Self {
        Self {
            available: status.available,
            version: status.version,
            logged_in: status.logged_in,
            gh_path: status.gh_path,
            host: status.host,
            cwd_ok: status.cwd_ok,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoRefDto {
    pub host: Option<String>,
    pub owner: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct AuthorDto {
    pub login: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    pub is_bot: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct PrDto {
    #[ts(type = "number")]
    pub number: u32,
    pub title: String,
    pub url: String,
    pub state: PrStateView,
    pub author: AuthorDto,
    pub head: String,
    pub base: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mergeable: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub review_decision: Option<String>,
    pub checks: CheckState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct PrListDto {
    pub items: Vec<PrDto>,
}

impl From<Author> for AuthorDto {
    fn from(author: Author) -> Self {
        Self {
            login: author.login,
            name: author.name,
            is_bot: author.is_bot,
        }
    }
}

impl From<PullRequest> for PrDto {
    fn from(pr: PullRequest) -> Self {
        Self {
            number: pr.number,
            title: pr.title,
            url: pr.url,
            state: pr.state,
            author: AuthorDto::from(pr.author),
            head: pr.head,
            base: pr.base,
            updated_at: pr.updated_at,
            mergeable: pr.mergeable,
            review_decision: pr.review_decision,
            checks: pr.checks,
        }
    }
}

fn parse_state_filter(raw: Option<&str>) -> Result<PrState, CmdError> {
    match raw.unwrap_or("open") {
        "open" => Ok(PrState::Open),
        "closed" => Ok(PrState::Closed),
        "merged" => Ok(PrState::Merged),
        "all" => Ok(PrState::All),
        other => Err(CmdError::keyed_with(
            50000,
            "err.gh.badState",
            format!("未知的 PR 状态：{other}"),
            BTreeMap::from([("detail".to_string(), other.to_string())]),
        )),
    }
}

#[tauri::command]
pub async fn gh_pr_list(
    state: State<'_, GhState>,
    repo: RepoRefDto,
    state_filter: Option<String>,
    force: Option<bool>,
) -> Result<PrListDto, CmdError> {
    let owner = repo.owner.trim();
    let name = repo.name.trim();
    if owner.is_empty() || name.is_empty() {
        return Err(CmdError::keyed_with(
            50000,
            "err.gh.repoRequired",
            "仓库的 owner 和 name 不能为空",
            BTreeMap::from([
                ("owner".to_string(), repo.owner.clone()),
                ("name".to_string(), repo.name.clone()),
            ]),
        ));
    }

    let state_filter = parse_state_filter(state_filter.as_deref())?;
    let repo = RepoRef {
        host: repo
            .host
            .map(|host| host.trim().to_string())
            .filter(|host| !host.is_empty()),
        owner: owner.to_string(),
        name: name.to_string(),
    };

    match state
        .0
        .list_prs(&repo, state_filter, force.unwrap_or(false))
        .await
    {
        Ok(items) => Ok(PrListDto {
            items: items.into_iter().map(PrDto::from).collect(),
        }),
        Err(error) => {
            tracing::warn!(
                target: "sincearc::gh",
                code = error.code(),
                error = ?error,
                "gh pr list failed"
            );
            Err(to_cmd_error(error))
        }
    }
}

#[tauri::command]
pub async fn gh_status(
    state: State<'_, GhState>,
    force: Option<bool>,
) -> Result<GhStatusDto, CmdError> {
    match state.0.status(force.unwrap_or(false)).await {
        Ok(status) => Ok(GhStatusDto::from(status)),
        Err(error) => {
            tracing::warn!(
                target: "sincearc::gh",
                code = error.code(),
                error = ?error,
                "gh status check failed"
            );
            Err(to_cmd_error(error))
        }
    }
}

fn to_cmd_error(error: GhError) -> CmdError {
    let code = u32::from(error.code());
    match error {
        GhError::NotInstalled => {
            CmdError::keyed(code, "err.gh.notInstalled", "没找到 GitHub CLI（gh）")
        }
        GhError::NotLoggedIn => CmdError::keyed(code, "err.gh.notLoggedIn", "gh 还没登录 GitHub"),
        GhError::Timeout => failed(code, "超时（2s/5s）"),
        GhError::CliFailed { stderr } => failed(code, first_line(&stderr)),
        GhError::RateLimited { reset } => failed(code, format!("限流，reset {reset}")),
        GhError::RepoUnavailable => failed(code, "仓库不存在或没有权限"),
        GhError::ParseFailed { version } => failed(code, format!("解析失败（gh {version}）")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bad_state_is_rejected() {
        for raw in ["opened", "OPEN", "", "draft"] {
            let error = parse_state_filter(Some(raw)).unwrap_err();
            assert_eq!(error.code, 50000);
            assert_eq!(error.key.as_deref(), Some("err.gh.badState"));
            assert_eq!(
                error
                    .params
                    .as_ref()
                    .and_then(|params| params.get("detail"))
                    .map(String::as_str),
                Some(raw)
            );
        }
    }

    #[test]
    fn state_filter_accepts_known_values_and_defaults_to_open() {
        assert_eq!(parse_state_filter(None).unwrap(), PrState::Open);
        assert_eq!(parse_state_filter(Some("open")).unwrap(), PrState::Open);
        assert_eq!(parse_state_filter(Some("closed")).unwrap(), PrState::Closed);
        assert_eq!(parse_state_filter(Some("merged")).unwrap(), PrState::Merged);
        assert_eq!(parse_state_filter(Some("all")).unwrap(), PrState::All);
    }
}

fn failed(code: u32, detail: impl Into<String>) -> CmdError {
    let detail = detail.into();
    let detail = if detail.trim().is_empty() {
        "未知错误".to_string()
    } else {
        detail
    };
    CmdError::keyed_with(
        code,
        "err.gh.failed",
        format!("gh 执行失败：{detail}"),
        BTreeMap::from([("detail".to_string(), detail)]),
    )
}

fn first_line(value: &str) -> String {
    value.lines().next().unwrap_or("").trim().to_string()
}
