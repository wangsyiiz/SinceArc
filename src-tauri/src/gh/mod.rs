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
    Author, CheckState, DiffPage, FileChange, GhCli, GhError, GhStatus, PrDetail, PrState,
    PrStateView, PullRequest, RepoRef,
};
use self::service::{DiffPageError, GhService, MAX_PAGE_SIZE};

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct FileDto {
    pub path: String,
    #[ts(type = "number")]
    pub additions: u32,
    #[ts(type = "number")]
    pub deletions: u32,
    pub change_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct PrDetailDto {
    pub pr: PrDto,
    pub body: String,
    pub created_at: String,
    #[ts(type = "number")]
    pub additions: u32,
    #[ts(type = "number")]
    pub deletions: u32,
    #[ts(type = "number")]
    pub changed_files: u32,
    pub files: Vec<FileDto>,
    pub files_truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct DiffPageDto {
    pub lines: Vec<String>,
    #[ts(type = "number")]
    pub page: u32,
    #[ts(type = "number")]
    pub page_size: u32,
    #[ts(type = "number")]
    pub total_lines: usize,
    #[ts(type = "number")]
    pub total_pages: u32,
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

impl From<FileChange> for FileDto {
    fn from(file: FileChange) -> Self {
        Self {
            path: file.path,
            additions: file.additions,
            deletions: file.deletions,
            change_type: file.change_type,
        }
    }
}

impl From<PrDetail> for PrDetailDto {
    fn from(detail: PrDetail) -> Self {
        Self {
            pr: PrDto::from(detail.pr),
            body: detail.body,
            created_at: detail.created_at,
            additions: detail.additions,
            deletions: detail.deletions,
            changed_files: detail.changed_files,
            files: detail.files.into_iter().map(FileDto::from).collect(),
            files_truncated: detail.files_truncated,
        }
    }
}

impl From<DiffPage> for DiffPageDto {
    fn from(page: DiffPage) -> Self {
        Self {
            lines: page.lines,
            page: page.page,
            page_size: page.page_size,
            total_lines: page.total_lines,
            total_pages: page.total_pages,
        }
    }
}

fn validate_pr_number(number: u32) -> Result<u32, CmdError> {
    if number == 0 {
        return Err(CmdError::keyed_with(
            50000,
            "err.gh.badPrNumber",
            format!("PR 编号必须大于 0：{number}"),
            BTreeMap::from([("detail".to_string(), number.to_string())]),
        ));
    }
    Ok(number)
}

fn validate_page_size(page_size: Option<u32>) -> Result<u32, CmdError> {
    let page_size = page_size.unwrap_or(MAX_PAGE_SIZE);
    if !(1..=MAX_PAGE_SIZE).contains(&page_size) {
        return Err(bad_page_size(page_size));
    }
    Ok(page_size)
}

fn bad_page_size(size: u32) -> CmdError {
    CmdError::keyed_with(
        50000,
        "err.gh.badPageSize",
        format!("每页行数必须在 1..=200：{size}"),
        BTreeMap::from([("detail".to_string(), size.to_string())]),
    )
}

fn normalize_repo(repo: RepoRefDto) -> Result<RepoRef, CmdError> {
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

    Ok(RepoRef {
        host: repo
            .host
            .map(|host| host.trim().to_string())
            .filter(|host| !host.is_empty()),
        owner: owner.to_string(),
        name: name.to_string(),
    })
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
    let repo = normalize_repo(repo)?;
    let state_filter = parse_state_filter(state_filter.as_deref())?;

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
                "gh list failed"
            );
            Err(to_cmd_error(error))
        }
    }
}

#[tauri::command]
pub async fn gh_pr_detail(
    state: State<'_, GhState>,
    repo: RepoRefDto,
    number: u32,
    force: Option<bool>,
) -> Result<PrDetailDto, CmdError> {
    let number = validate_pr_number(number)?;
    let repo = normalize_repo(repo)?;

    match state
        .0
        .pr_detail(&repo, number, force.unwrap_or(false))
        .await
    {
        Ok(detail) => Ok(PrDetailDto::from(detail)),
        Err(error) => {
            tracing::warn!(
                target: "sincearc::gh",
                code = error.code(),
                number,
                error = ?error,
                "gh detail failed"
            );
            Err(to_cmd_error_for_pr(error, number))
        }
    }
}

#[tauri::command]
pub async fn gh_pr_diff(
    state: State<'_, GhState>,
    repo: RepoRefDto,
    number: u32,
    page: Option<u32>,
    page_size: Option<u32>,
    force: Option<bool>,
) -> Result<DiffPageDto, CmdError> {
    let number = validate_pr_number(number)?;
    let page_size = validate_page_size(page_size)?;
    let repo = normalize_repo(repo)?;

    match state
        .0
        .pr_diff_page(
            &repo,
            number,
            page.unwrap_or(0),
            Some(page_size),
            force.unwrap_or(false),
        )
        .await
    {
        Ok(page) => Ok(DiffPageDto::from(page)),
        Err(DiffPageError::BadPageSize(size)) => Err(bad_page_size(size)),
        Err(DiffPageError::Gh(error)) => {
            tracing::warn!(
                target: "sincearc::gh",
                code = error.code(),
                number,
                error = ?error,
                "gh diff failed"
            );
            Err(to_cmd_error_for_pr(error, number))
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
        GhError::Timeout => failed(code, "超时"),
        GhError::CliFailed { stderr } => failed(code, first_line(&stderr)),
        GhError::RateLimited { reset } => failed(code, format!("限流，reset {reset}")),
        GhError::RepoUnavailable => failed(code, "仓库不存在或没有权限"),
        GhError::PrNotFound => pr_not_found(code, None),
        GhError::ParseFailed { version } => failed(code, format!("解析失败（gh {version}）")),
    }
}

fn to_cmd_error_for_pr(error: GhError, number: u32) -> CmdError {
    let code = u32::from(error.code());
    match error {
        GhError::PrNotFound => pr_not_found(code, Some(number)),
        other => to_cmd_error(other),
    }
}

fn pr_not_found(code: u32, number: Option<u32>) -> CmdError {
    let detail = number.map_or_else(|| "编号不存在或已删除".to_string(), |n| format!("#{n}"));
    CmdError::keyed_with(
        code,
        "err.gh.prNotFound",
        format!("这个 PR 拿不到：{detail}"),
        BTreeMap::from([("detail".to_string(), detail)]),
    )
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

    #[test]
    fn bad_pr_number_rejected() {
        let error = validate_pr_number(0).unwrap_err();
        assert_eq!(error.code, 50000);
        assert_eq!(error.key.as_deref(), Some("err.gh.badPrNumber"));
        assert_eq!(
            error
                .params
                .as_ref()
                .and_then(|params| params.get("detail"))
                .map(String::as_str),
            Some("0")
        );
        assert_eq!(validate_pr_number(1).unwrap(), 1);
    }

    #[test]
    fn bad_page_size_rejected() {
        for size in [0, 201] {
            let error = validate_page_size(Some(size)).unwrap_err();
            assert_eq!(error.code, 50000);
            assert_eq!(error.key.as_deref(), Some("err.gh.badPageSize"));
            let expected = size.to_string();
            assert_eq!(
                error
                    .params
                    .as_ref()
                    .and_then(|params| params.get("detail"))
                    .map(String::as_str),
                Some(expected.as_str())
            );
        }
        assert_eq!(validate_page_size(None).unwrap(), 200);
        assert_eq!(validate_page_size(Some(1)).unwrap(), 1);
        assert_eq!(validate_page_size(Some(200)).unwrap(), 200);
    }

    #[test]
    fn pr_not_found_carries_code_and_number() {
        let error = to_cmd_error_for_pr(GhError::PrNotFound, 42);
        assert_eq!(error.code, 50716);
        assert_eq!(error.key.as_deref(), Some("err.gh.prNotFound"));
        assert_eq!(
            error
                .params
                .as_ref()
                .and_then(|params| params.get("detail"))
                .map(String::as_str),
            Some("#42")
        );
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
