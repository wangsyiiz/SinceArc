//! gh 命令层：DTO 映射与错误码/文案映射。

pub mod cli;
pub mod model;
pub mod repo;
pub mod service;

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::CmdError;

use self::model::{
    ActionResult, Author, Capability, CheckState, DenyReason, DiffPage, FileChange, GhAction,
    GhActionParams, GhCli, GhError, GhStatus, Issue, IssueState, IssueStateView, LatestRelease,
    MergeMethod, PrDetail, PrState, PrStateView, PullRequest, Release, RepoCounts, RepoListing,
    RepoMeta, RepoRef, RepoSummary, ReviewVerdict, TreeEntry, TreeEntryKind, Viewer, Workflow,
    WorkflowRun,
};
use self::service::{DiffPageError, GhService, DEFAULT_REPO_LIST_LIMIT, MAX_PAGE_SIZE};

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct ViewerDto {
    pub state: String,
    pub login: Option<String>,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
}

impl From<RepoRef> for RepoRefDto {
    fn from(repo: RepoRef) -> Self {
        Self {
            host: repo.host,
            owner: repo.owner,
            name: repo.name,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
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

/// `gh repo list` 的一行。列表用于「从 GitHub 添加」：身份 + 展示元数据，
/// 不代表已经落库（落库由 `repos_add_remote` / `repos_add_local` 负责）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct GhRepoListingDto {
    pub host: Option<String>,
    pub owner: String,
    pub name: String,
    pub default_branch: Option<String>,
    pub is_private: bool,
    #[ts(type = "number | null")]
    pub updated_at: Option<i64>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct GhRepoListDto {
    pub items: Vec<GhRepoListingDto>,
    pub has_more: bool,
}

impl From<RepoListing> for GhRepoListingDto {
    fn from(listing: RepoListing) -> Self {
        Self {
            host: listing.repo.host,
            owner: listing.repo.owner,
            name: listing.repo.name,
            default_branch: listing.default_branch,
            is_private: listing.is_private,
            updated_at: listing.updated_at,
            description: listing.description,
        }
    }
}

// ---------------------------------------------------------------------------
// 项目 dashboard DTO（docs/gh.md §10.6）
// ---------------------------------------------------------------------------

/// 错误块的 DTO；与 `CmdError` 同形，但能经 ts-rs 出类型。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct GhErrorDto {
    #[ts(type = "number")]
    pub code: u32,
    pub msg: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub params: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct LatestReleaseDto {
    pub tag_name: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub published_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct RepoMetaDto {
    pub name_with_owner: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub description: Option<String>,
    pub visibility: String,
    pub default_branch: String,
    pub topics: Vec<String>,
    pub pushed_at: String,
    #[ts(type = "number")]
    pub stargazers: u64,
    #[ts(type = "number")]
    pub forks: u64,
    pub is_archived: bool,
    pub has_issues: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub latest_release: Option<LatestReleaseDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct RepoMetaBlockDto {
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repo: Option<RepoMetaDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<GhErrorDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct RepoCountsBlockDto {
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<GhErrorDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null")]
    pub open_prs: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null")]
    pub open_issues: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct RepoSummaryDto {
    pub meta: RepoMetaBlockDto,
    pub counts: RepoCountsBlockDto,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct IssueDto {
    #[ts(type = "number")]
    pub number: u32,
    pub title: String,
    pub state: IssueStateView,
    pub author: AuthorDto,
    pub labels: Vec<String>,
    pub updated_at: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct IssueListDto {
    pub items: Vec<IssueDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct ReleaseDto {
    pub tag_name: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub published_at: Option<String>,
    pub is_latest: bool,
    pub is_draft: bool,
    pub is_prerelease: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct ReleaseListDto {
    pub items: Vec<ReleaseDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct WorkflowRunDto {
    #[ts(type = "number")]
    pub id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub workflow_name: Option<String>,
    pub title: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub conclusion: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub branch: Option<String>,
    pub event: String,
    pub created_at: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct WorkflowRunListDto {
    pub items: Vec<WorkflowRunDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct WorkflowDto {
    #[ts(type = "number")]
    pub id: u64,
    pub name: String,
    pub path: String,
    pub state: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct WorkflowListDto {
    pub items: Vec<WorkflowDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct TreeEntryDto {
    pub name: String,
    pub path: String,
    pub kind: TreeEntryKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null")]
    pub size: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct TreeEntryListDto {
    pub items: Vec<TreeEntryDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct CapabilityDto {
    pub action: String,
    pub allowed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub scope: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct CapabilitiesDto {
    pub actions: Vec<CapabilityDto>,
}

#[derive(Debug, Clone, Deserialize, ts_rs::TS)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub enum GhActionParamsDto {
    PrComment {
        #[ts(type = "number")]
        number: u32,
        body: String,
    },
    PrReview {
        #[ts(type = "number")]
        number: u32,
        verdict: ReviewVerdict,
        body: Option<String>,
    },
    PrMerge {
        #[ts(type = "number")]
        number: u32,
        method: Option<MergeMethod>,
        match_head_commit: String,
        delete_branch: bool,
    },
    PrClose {
        #[ts(type = "number")]
        number: u32,
    },
    PrReopen {
        #[ts(type = "number")]
        number: u32,
    },
    IssueComment {
        #[ts(type = "number")]
        number: u32,
        body: String,
    },
    IssueClose {
        #[ts(type = "number")]
        number: u32,
    },
    WorkflowDispatch {
        workflow: String,
        git_ref: String,
        inputs: BTreeMap<String, String>,
    },
    RunRerun {
        #[ts(type = "number")]
        run_id: u64,
        failed_only: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct ActionResultDto {
    pub action: String,
    pub ok: bool,
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

impl From<LatestRelease> for LatestReleaseDto {
    fn from(release: LatestRelease) -> Self {
        Self {
            tag_name: release.tag_name,
            name: release.name,
            published_at: release.published_at,
        }
    }
}

impl From<RepoMeta> for RepoMetaDto {
    fn from(meta: RepoMeta) -> Self {
        Self {
            name_with_owner: meta.name_with_owner,
            description: meta.description,
            visibility: meta.visibility,
            default_branch: meta.default_branch,
            topics: meta.topics,
            pushed_at: meta.pushed_at,
            stargazers: meta.stargazers,
            forks: meta.forks,
            is_archived: meta.is_archived,
            has_issues: meta.has_issues,
            latest_release: meta.latest_release.map(LatestReleaseDto::from),
        }
    }
}

impl From<Issue> for IssueDto {
    fn from(issue: Issue) -> Self {
        Self {
            number: issue.number,
            title: issue.title,
            state: issue.state,
            author: AuthorDto::from(issue.author),
            labels: issue.labels,
            updated_at: issue.updated_at,
            url: issue.url,
        }
    }
}

impl From<Release> for ReleaseDto {
    fn from(release: Release) -> Self {
        Self {
            tag_name: release.tag_name,
            name: release.name,
            published_at: release.published_at,
            is_latest: release.is_latest,
            is_draft: release.is_draft,
            is_prerelease: release.is_prerelease,
        }
    }
}

impl From<WorkflowRun> for WorkflowRunDto {
    fn from(run: WorkflowRun) -> Self {
        Self {
            id: run.id,
            workflow_name: run.workflow_name,
            title: run.title,
            status: run.status,
            conclusion: run.conclusion,
            branch: run.branch,
            event: run.event,
            created_at: run.created_at,
            url: run.url,
        }
    }
}

impl From<Workflow> for WorkflowDto {
    fn from(workflow: Workflow) -> Self {
        Self {
            id: workflow.id,
            name: workflow.name,
            path: workflow.path,
            state: workflow.state,
        }
    }
}

impl From<TreeEntry> for TreeEntryDto {
    fn from(entry: TreeEntry) -> Self {
        Self {
            name: entry.name,
            path: entry.path,
            kind: entry.kind,
            size: entry.size,
        }
    }
}

impl From<ActionResult> for ActionResultDto {
    fn from(result: ActionResult) -> Self {
        Self {
            action: result.action.as_str().to_string(),
            ok: result.ok,
        }
    }
}

fn deny_reason_parts(reason: &DenyReason) -> (&'static str, Option<String>) {
    match reason {
        DenyReason::Readonly => ("readonly", None),
        DenyReason::MissingScope { scope } => ("missingScope", Some(scope.clone())),
        DenyReason::Archived => ("archived", None),
        DenyReason::NoPermission => ("noPermission", None),
    }
}

fn deny_reason_text(reason: &DenyReason) -> String {
    match reason {
        DenyReason::Readonly => "当前版本只读：这个动作还没有开放".to_string(),
        DenyReason::MissingScope { scope } => format!("当前 gh 登录缺少 scope：{scope}"),
        DenyReason::Archived => "仓库已归档，不能执行写动作".to_string(),
        DenyReason::NoPermission => "当前账号没有权限执行这个动作".to_string(),
    }
}

fn repo_meta_block(result: Result<RepoMeta, GhError>) -> RepoMetaBlockDto {
    match result {
        Ok(meta) => RepoMetaBlockDto {
            state: "ready".to_string(),
            repo: Some(RepoMetaDto::from(meta)),
            error: None,
        },
        Err(error) => RepoMetaBlockDto {
            state: "failed".to_string(),
            repo: None,
            error: Some(error_dto(error)),
        },
    }
}

fn repo_counts_block(result: Result<RepoCounts, GhError>) -> RepoCountsBlockDto {
    match result {
        Ok(counts) => RepoCountsBlockDto {
            state: "ready".to_string(),
            error: None,
            open_prs: counts.open_prs,
            open_issues: counts.open_issues,
        },
        Err(error) => RepoCountsBlockDto {
            state: "failed".to_string(),
            error: Some(error_dto(error)),
            open_prs: None,
            open_issues: None,
        },
    }
}

fn error_dto(error: GhError) -> GhErrorDto {
    let error = to_cmd_error(error);
    GhErrorDto {
        code: error.code,
        msg: error.msg,
        key: error.key,
        params: error.params,
    }
}

fn action_params_from_dto(params: GhActionParamsDto) -> Result<GhActionParams, CmdError> {
    Ok(match params {
        GhActionParamsDto::PrComment { number, body } => GhActionParams::PrComment { number, body },
        GhActionParamsDto::PrReview {
            number,
            verdict,
            body,
        } => GhActionParams::PrReview {
            number,
            verdict,
            body,
        },
        GhActionParamsDto::PrMerge {
            number,
            method,
            match_head_commit,
            delete_branch,
        } => {
            let Some(method) = method else {
                return Err(bad_action_param(
                    GhAction::PrMerge,
                    "method",
                    "合并方式必须显式指定 squash / merge / rebase",
                ));
            };
            GhActionParams::PrMerge {
                number,
                method,
                match_head_commit,
                delete_branch,
            }
        }
        GhActionParamsDto::PrClose { number } => GhActionParams::PrClose { number },
        GhActionParamsDto::PrReopen { number } => GhActionParams::PrReopen { number },
        GhActionParamsDto::IssueComment { number, body } => {
            GhActionParams::IssueComment { number, body }
        }
        GhActionParamsDto::IssueClose { number } => GhActionParams::IssueClose { number },
        GhActionParamsDto::WorkflowDispatch {
            workflow,
            git_ref,
            inputs,
        } => GhActionParams::WorkflowDispatch {
            workflow,
            git_ref,
            inputs,
        },
        GhActionParamsDto::RunRerun {
            run_id,
            failed_only,
        } => GhActionParams::RunRerun {
            run_id,
            failed_only,
        },
    })
}

fn bad_action_param(action: GhAction, field: &str, detail: impl Into<String>) -> CmdError {
    let detail = detail.into();
    CmdError::keyed_with(
        50721,
        "err.gh.badActionParams",
        format!("动作参数不合法：{detail}"),
        BTreeMap::from([
            ("action".to_string(), action.as_str().to_string()),
            ("field".to_string(), field.to_string()),
            ("detail".to_string(), detail),
        ]),
    )
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

fn parse_issue_state(raw: Option<&str>) -> Result<IssueState, CmdError> {
    match raw.unwrap_or("open") {
        "open" => Ok(IssueState::Open),
        "closed" => Ok(IssueState::Closed),
        "all" => Ok(IssueState::All),
        other => Err(CmdError::keyed_with(
            50000,
            "err.gh.badIssueState",
            format!("未知的 Issue 状态：{other}"),
            BTreeMap::from([("detail".to_string(), other.to_string())]),
        )),
    }
}

const DEFAULT_DASHBOARD_LIMIT: u32 = 30;

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

#[tauri::command]
pub async fn gh_viewer(
    state: State<'_, GhState>,
    force: Option<bool>,
) -> Result<ViewerDto, CmdError> {
    match state.0.viewer(force.unwrap_or(false)).await {
        Ok(Viewer {
            login,
            name,
            avatar_url,
        }) => Ok(ViewerDto {
            state: "ready".to_string(),
            login: Some(login),
            name,
            avatar_url,
        }),
        Err(GhError::NotLoggedIn) => Ok(ViewerDto {
            state: "loggedOut".to_string(),
            login: None,
            name: None,
            avatar_url: None,
        }),
        Err(GhError::NotInstalled) => Ok(ViewerDto {
            state: "unavailable".to_string(),
            login: None,
            name: None,
            avatar_url: None,
        }),
        Err(error) => {
            tracing::warn!(
                target: "sincearc::gh",
                code = error.code(),
                error = ?error,
                "gh viewer failed"
            );
            Err(to_cmd_error(error))
        }
    }
}

/// 「从 GitHub 添加」的仓库列表。`limit` 缺省 30，上限 100；
/// `hasMore` 表示切片前长度至少达到 limit（docs/gh.md §2.2 的分页口径）。
#[tauri::command]
pub async fn gh_repos_list(
    state: State<'_, GhState>,
    owner: Option<String>,
    limit: Option<u32>,
    force: Option<bool>,
) -> Result<GhRepoListDto, CmdError> {
    let owner = owner
        .map(|owner| owner.trim().to_string())
        .filter(|owner| !owner.is_empty());
    let limit = limit.unwrap_or(DEFAULT_REPO_LIST_LIMIT);

    match state
        .0
        .list_repos_page(owner.as_deref(), limit, force.unwrap_or(false))
        .await
    {
        Ok(page) => Ok(GhRepoListDto {
            items: page.items.into_iter().map(GhRepoListingDto::from).collect(),
            has_more: page.has_more,
        }),
        Err(error) => {
            tracing::warn!(
                target: "sincearc::gh",
                code = error.code(),
                error = ?error,
                "gh repo list failed"
            );
            Err(to_cmd_error(error))
        }
    }
}

#[tauri::command]
pub async fn gh_repo_summary(
    state: State<'_, GhState>,
    repo: RepoRefDto,
    force: Option<bool>,
) -> Result<RepoSummaryDto, CmdError> {
    let repo = normalize_repo(repo)?;

    let summary: RepoSummary = state.0.repo_summary(&repo, force.unwrap_or(false)).await;
    if let Err(error) = &summary.meta {
        tracing::warn!(
            target: "sincearc::gh",
            code = error.code(),
            block = "meta",
            error = ?error,
            "gh repo summary block failed"
        );
    }
    if let Err(error) = &summary.counts {
        tracing::warn!(
            target: "sincearc::gh",
            code = error.code(),
            block = "counts",
            error = ?error,
            "gh repo summary block failed"
        );
    }

    Ok(RepoSummaryDto {
        meta: repo_meta_block(summary.meta),
        counts: repo_counts_block(summary.counts),
    })
}

#[tauri::command]
pub async fn gh_issue_list(
    state: State<'_, GhState>,
    repo: RepoRefDto,
    state_filter: Option<String>,
    limit: Option<u32>,
    force: Option<bool>,
) -> Result<IssueListDto, CmdError> {
    let repo = normalize_repo(repo)?;
    let issue_state = parse_issue_state(state_filter.as_deref())?;
    let limit = limit.unwrap_or(DEFAULT_DASHBOARD_LIMIT);

    match state
        .0
        .list_issues(&repo, issue_state, limit, force.unwrap_or(false))
        .await
    {
        Ok(items) => Ok(IssueListDto {
            items: items.into_iter().map(IssueDto::from).collect(),
        }),
        Err(error) => {
            tracing::warn!(
                target: "sincearc::gh",
                code = error.code(),
                error = ?error,
                "gh issue list failed"
            );
            Err(to_cmd_error(error))
        }
    }
}

#[tauri::command]
pub async fn gh_release_list(
    state: State<'_, GhState>,
    repo: RepoRefDto,
    limit: Option<u32>,
    force: Option<bool>,
) -> Result<ReleaseListDto, CmdError> {
    let repo = normalize_repo(repo)?;
    let limit = limit.unwrap_or(DEFAULT_DASHBOARD_LIMIT);

    match state
        .0
        .list_releases(&repo, limit, force.unwrap_or(false))
        .await
    {
        Ok(items) => Ok(ReleaseListDto {
            items: items.into_iter().map(ReleaseDto::from).collect(),
        }),
        Err(error) => {
            tracing::warn!(
                target: "sincearc::gh",
                code = error.code(),
                error = ?error,
                "gh release list failed"
            );
            Err(to_cmd_error(error))
        }
    }
}

#[tauri::command]
pub async fn gh_runs_list(
    state: State<'_, GhState>,
    repo: RepoRefDto,
    limit: Option<u32>,
    force: Option<bool>,
) -> Result<WorkflowRunListDto, CmdError> {
    let repo = normalize_repo(repo)?;
    let limit = limit.unwrap_or(DEFAULT_DASHBOARD_LIMIT);

    match state
        .0
        .list_runs(&repo, limit, force.unwrap_or(false))
        .await
    {
        Ok(items) => Ok(WorkflowRunListDto {
            items: items.into_iter().map(WorkflowRunDto::from).collect(),
        }),
        Err(error) => {
            tracing::warn!(
                target: "sincearc::gh",
                code = error.code(),
                error = ?error,
                "gh run list failed"
            );
            Err(to_cmd_error(error))
        }
    }
}

#[tauri::command]
pub async fn gh_workflows_list(
    state: State<'_, GhState>,
    repo: RepoRefDto,
    force: Option<bool>,
) -> Result<WorkflowListDto, CmdError> {
    let repo = normalize_repo(repo)?;

    match state.0.list_workflows(&repo, force.unwrap_or(false)).await {
        Ok(items) => Ok(WorkflowListDto {
            items: items.into_iter().map(WorkflowDto::from).collect(),
        }),
        Err(error) => {
            tracing::warn!(
                target: "sincearc::gh",
                code = error.code(),
                error = ?error,
                "gh workflow list failed"
            );
            Err(to_cmd_error(error))
        }
    }
}

#[tauri::command]
pub async fn gh_repo_tree(
    state: State<'_, GhState>,
    repo: RepoRefDto,
    path: Option<String>,
    git_ref: Option<String>,
    force: Option<bool>,
) -> Result<TreeEntryListDto, CmdError> {
    let repo = normalize_repo(repo)?;
    let path = path
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty());
    let git_ref = git_ref
        .map(|git_ref| git_ref.trim().to_string())
        .filter(|git_ref| !git_ref.is_empty());

    match state
        .0
        .repo_tree(
            &repo,
            path.as_deref(),
            git_ref.as_deref(),
            force.unwrap_or(false),
        )
        .await
    {
        Ok(items) => Ok(TreeEntryListDto {
            items: items.into_iter().map(TreeEntryDto::from).collect(),
        }),
        Err(error) => {
            tracing::warn!(
                target: "sincearc::gh",
                code = error.code(),
                error = ?error,
                "gh repo tree failed"
            );
            Err(to_cmd_error(error))
        }
    }
}

#[tauri::command]
pub async fn gh_capabilities(
    state: State<'_, GhState>,
    repo: RepoRefDto,
) -> Result<CapabilitiesDto, CmdError> {
    let repo = normalize_repo(repo)?;

    match state.0.capabilities(&repo).await {
        Ok(actions) => Ok(CapabilitiesDto {
            actions: actions
                .into_iter()
                .map(|capability: Capability| {
                    let (reason, scope) = capability
                        .reason
                        .as_ref()
                        .map(deny_reason_parts)
                        .map_or((None, None), |(reason, scope)| {
                            (Some(reason.to_string()), scope)
                        });
                    CapabilityDto {
                        action: capability.action.as_str().to_string(),
                        allowed: capability.allowed,
                        reason,
                        scope,
                    }
                })
                .collect(),
        }),
        Err(error) => {
            tracing::warn!(
                target: "sincearc::gh",
                code = error.code(),
                error = ?error,
                "gh capabilities failed"
            );
            Err(to_cmd_error(error))
        }
    }
}

#[tauri::command]
pub async fn gh_action(
    state: State<'_, GhState>,
    repo: RepoRefDto,
    params: GhActionParamsDto,
) -> Result<ActionResultDto, CmdError> {
    let repo = normalize_repo(repo)?;
    let params = action_params_from_dto(params)?;

    match state.0.action(&repo, &params).await {
        Ok(result) => Ok(ActionResultDto::from(result)),
        Err(error) => {
            tracing::info!(
                target: "sincearc::gh",
                code = error.code(),
                action = params.action().as_str(),
                error = ?error,
                "gh action rejected"
            );
            Err(to_cmd_error(error))
        }
    }
}

/// 从本地目录解析仓库身份（docs/gh.md §2.1）。纯文件读，不调 gh、不起进程。
#[tauri::command]
pub fn gh_repo_resolve(path: String) -> Result<RepoRefDto, CmdError> {
    if path.trim().is_empty() {
        return Err(CmdError::keyed_with(
            50000,
            "err.gh.repoPathRequired",
            "仓库路径不能为空",
            BTreeMap::from([("path".to_string(), path)]),
        ));
    }

    repo::resolve_repo(&path)
        .map(RepoRefDto::from)
        .map_err(|error| {
            tracing::warn!(
                target: "sincearc::gh",
                code = error.code(),
                error = ?error,
                "gh repo resolve failed"
            );
            to_cmd_error(error)
        })
}

pub(crate) fn to_cmd_error(error: GhError) -> CmdError {
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
        GhError::NotGitRepo { path } => CmdError::keyed_with(
            code,
            "err.gh.notGitRepo",
            format!("这个目录还不是 git 仓库：{path}"),
            BTreeMap::from([("path".to_string(), path)]),
        ),
        GhError::NoRemote { path, detail } => CmdError::keyed_with(
            code,
            "err.gh.noRemote",
            format!("没找到可用的 origin 远端：{detail}"),
            BTreeMap::from([("path".to_string(), path), ("detail".to_string(), detail)]),
        ),
        GhError::ActionDenied { action, reason } => {
            let (reason_key, scope) = deny_reason_parts(&reason);
            let mut params = BTreeMap::from([
                ("action".to_string(), action.as_str().to_string()),
                ("reason".to_string(), reason_key.to_string()),
            ]);
            if let Some(scope) = scope {
                params.insert("scope".to_string(), scope);
            }
            CmdError::keyed_with(
                code,
                "err.gh.actionDenied",
                format!("{}：{}", action.as_str(), deny_reason_text(&reason)),
                params,
            )
        }
        GhError::BadActionParams {
            action,
            field,
            detail,
        } => CmdError::keyed_with(
            code,
            "err.gh.badActionParams",
            format!("动作参数不合法：{detail}"),
            BTreeMap::from([
                ("action".to_string(), action.as_str().to_string()),
                ("field".to_string(), field),
                ("detail".to_string(), detail),
            ]),
        ),
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

    #[test]
    fn issue_state_filter_accepts_known_values_and_defaults_to_open() {
        assert_eq!(parse_issue_state(None).unwrap(), IssueState::Open);
        assert_eq!(parse_issue_state(Some("open")).unwrap(), IssueState::Open);
        assert_eq!(
            parse_issue_state(Some("closed")).unwrap(),
            IssueState::Closed
        );
        assert_eq!(parse_issue_state(Some("all")).unwrap(), IssueState::All);
        assert_eq!(parse_issue_state(Some("opened")).unwrap_err().code, 50000);
    }

    #[test]
    fn pr_merge_without_explicit_method_is_50721() {
        let error = action_params_from_dto(GhActionParamsDto::PrMerge {
            number: 1,
            method: None,
            match_head_commit: "abc".to_string(),
            delete_branch: false,
        })
        .unwrap_err();
        assert_eq!(error.code, 50721);
        assert_eq!(error.key.as_deref(), Some("err.gh.badActionParams"));
        assert_eq!(
            error
                .params
                .as_ref()
                .and_then(|params| params.get("field"))
                .map(String::as_str),
            Some("method")
        );
    }

    #[test]
    fn action_errors_map_to_50720_and_50721() {
        let denied = to_cmd_error(GhError::ActionDenied {
            action: GhAction::PrClose,
            reason: DenyReason::Readonly,
        });
        assert_eq!(denied.code, 50720);
        assert_eq!(denied.key.as_deref(), Some("err.gh.actionDenied"));

        let bad = to_cmd_error(GhError::BadActionParams {
            action: GhAction::PrComment,
            field: "body".to_string(),
            detail: "评论正文不能为空".to_string(),
        });
        assert_eq!(bad.code, 50721);
        assert_eq!(bad.key.as_deref(), Some("err.gh.badActionParams"));
    }

    #[test]
    fn summary_blocks_degrade_independently() {
        let meta = repo_meta_block(Err(GhError::Timeout));
        assert_eq!(meta.state, "failed");
        assert!(meta.repo.is_none());
        assert_eq!(meta.error.as_ref().map(|error| error.code), Some(50714));

        let counts = repo_counts_block(Ok(RepoCounts {
            open_prs: Some(1),
            open_issues: Some(2),
        }));
        assert_eq!(counts.state, "ready");
        assert_eq!(counts.open_prs, Some(1));
        assert_eq!(counts.open_issues, Some(2));
    }
}
