//! gh 领域模型：与命令行参数、进程和 DTO 解耦。

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoRef {
    pub host: Option<String>,
    pub owner: String,
    pub name: String,
}

/// `gh repo list` 的一行：远端身份 + 列表展示需要的元数据。
/// CLI 的 JSON 字段名与 ISO 时间字符串在 adapter 里消化完才到这里。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoListing {
    pub repo: RepoRef,
    pub default_branch: Option<String>,
    pub is_private: bool,
    pub updated_at: Option<i64>,
    pub description: Option<String>,
}

/// `gh repo list` 的单次上限。domain 总是按这个值拉满再切片，
/// adapter 收到越界值同样夹到这里（两处都守，避免调用方绕过）。
pub const MAX_REPO_LIST_LIMIT: u32 = 100;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Author {
    pub login: String,
    pub name: Option<String>,
    pub is_bot: bool,
}

/// 查询 PR 列表时使用的状态过滤。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PrState {
    Open,
    Closed,
    Merged,
    All,
}

/// 单条 PR 的视图态：draft 与 open 在 gh 的 `state` 里是同一个值。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub enum PrStateView {
    Open,
    Draft,
    Merged,
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub enum CheckState {
    Pending,
    Passing,
    Failing,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequest {
    pub number: u32,
    pub title: String,
    pub url: String,
    pub state: PrStateView,
    pub author: Author,
    pub head: String,
    pub base: String,
    pub updated_at: String,
    pub mergeable: Option<String>,
    pub review_decision: Option<String>,
    pub checks: CheckState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GhStatus {
    pub available: bool,
    pub version: Option<String>,
    pub logged_in: bool,
    pub gh_path: Option<String>,
    pub host: Option<String>,
    pub cwd_ok: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Viewer {
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileChange {
    pub path: String,
    pub additions: u32,
    pub deletions: u32,
    pub change_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrDetail {
    pub pr: PullRequest,
    pub body: String,
    pub created_at: String,
    pub additions: u32,
    pub deletions: u32,
    pub changed_files: u32,
    pub files: Vec<FileChange>,
    pub files_truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffPage {
    pub lines: Vec<String>,
    pub page: u32,
    pub page_size: u32,
    pub total_lines: usize,
    pub total_pages: u32,
}

// ---------------------------------------------------------------------------
// 项目 dashboard（只读部分，docs/gh.md §10）
// ---------------------------------------------------------------------------

/// 仓库 dashboard 的元数据块。与 `gh repo view` 的原始形状解耦。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoMeta {
    pub name_with_owner: String,
    pub description: Option<String>,
    pub visibility: String,
    pub default_branch: String,
    pub topics: Vec<String>,
    pub pushed_at: String,
    pub stargazers: u64,
    pub forks: u64,
    pub is_archived: bool,
    pub has_issues: bool,
    pub latest_release: Option<LatestRelease>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LatestRelease {
    pub tag_name: String,
    pub name: String,
    pub published_at: Option<String>,
}

/// GraphQL 的 `issues.totalCount` **不含 PR**（docs/gh.md §10.4），
/// 所以两个数字各取各的，不做减法。`None` 表示这一项没拿到。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RepoCounts {
    pub open_prs: Option<u32>,
    pub open_issues: Option<u32>,
}

/// summary 的两块各自独立降级（§10.5）：一块失败不影响另一块。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoSummary {
    pub meta: Result<RepoMeta, GhError>,
    pub counts: Result<RepoCounts, GhError>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum IssueState {
    Open,
    Closed,
    All,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub enum IssueStateView {
    Open,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issue {
    pub number: u32,
    pub title: String,
    pub state: IssueStateView,
    pub author: Author,
    pub labels: Vec<String>,
    pub updated_at: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Release {
    pub tag_name: String,
    pub name: String,
    pub published_at: Option<String>,
    pub is_latest: bool,
    pub is_draft: bool,
    pub is_prerelease: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowRun {
    pub id: u64,
    pub workflow_name: Option<String>,
    pub title: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub branch: Option<String>,
    pub event: String,
    pub created_at: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Workflow {
    pub id: u64,
    pub name: String,
    pub path: String,
    pub state: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub enum TreeEntryKind {
    File,
    Dir,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeEntry {
    pub name: String,
    pub path: String,
    pub kind: TreeEntryKind,
    pub size: Option<u64>,
}

// ---------------------------------------------------------------------------
// 写接口骨架（W2，docs/gh.md §11；首版一律不执行）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum GhAction {
    PrComment,
    PrReview,
    PrMerge,
    PrClose,
    PrReopen,
    IssueComment,
    IssueClose,
    WorkflowDispatch,
    RunRerun,
}

impl GhAction {
    pub const ALL: [Self; 9] = [
        Self::PrComment,
        Self::PrReview,
        Self::PrMerge,
        Self::PrClose,
        Self::PrReopen,
        Self::IssueComment,
        Self::IssueClose,
        Self::WorkflowDispatch,
        Self::RunRerun,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::PrComment => "pr_comment",
            Self::PrReview => "pr_review",
            Self::PrMerge => "pr_merge",
            Self::PrClose => "pr_close",
            Self::PrReopen => "pr_reopen",
            Self::IssueComment => "issue_comment",
            Self::IssueClose => "issue_close",
            Self::WorkflowDispatch => "workflow_dispatch",
            Self::RunRerun => "run_rerun",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub enum ReviewVerdict {
    Approve,
    RequestChanges,
    Comment,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub enum MergeMethod {
    Squash,
    Merge,
    Rebase,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DenyReason {
    Readonly,
    MissingScope { scope: String },
    Archived,
    NoPermission,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Capability {
    pub action: GhAction,
    pub allowed: bool,
    pub reason: Option<DenyReason>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GhActionParams {
    PrComment {
        number: u32,
        body: String,
    },
    PrReview {
        number: u32,
        verdict: ReviewVerdict,
        body: Option<String>,
    },
    PrMerge {
        number: u32,
        method: MergeMethod,
        match_head_commit: String,
        delete_branch: bool,
    },
    PrClose {
        number: u32,
    },
    PrReopen {
        number: u32,
    },
    IssueComment {
        number: u32,
        body: String,
    },
    IssueClose {
        number: u32,
    },
    WorkflowDispatch {
        workflow: String,
        git_ref: String,
        inputs: std::collections::BTreeMap<String, String>,
    },
    RunRerun {
        run_id: u64,
        failed_only: bool,
    },
}

impl GhActionParams {
    pub fn action(&self) -> GhAction {
        match self {
            Self::PrComment { .. } => GhAction::PrComment,
            Self::PrReview { .. } => GhAction::PrReview,
            Self::PrMerge { .. } => GhAction::PrMerge,
            Self::PrClose { .. } => GhAction::PrClose,
            Self::PrReopen { .. } => GhAction::PrReopen,
            Self::IssueComment { .. } => GhAction::IssueComment,
            Self::IssueClose { .. } => GhAction::IssueClose,
            Self::WorkflowDispatch { .. } => GhAction::WorkflowDispatch,
            Self::RunRerun { .. } => GhAction::RunRerun,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionResult {
    pub action: GhAction,
    pub ok: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GhError {
    NotInstalled,
    NotLoggedIn,
    RateLimited {
        reset: String,
    },
    RepoUnavailable,
    PrNotFound,
    Timeout,
    CliFailed {
        stderr: String,
    },
    ParseFailed {
        version: String,
    },
    /// 从本地路径向上找不到 `.git`（docs/gh.md §2.1 第 1 步）。
    NotGitRepo {
        path: String,
    },
    /// 找到 git 仓库但没有可用远端，或远端地址认不出（§2.1 第 3–4 步）。
    NoRemote {
        path: String,
        detail: String,
    },
    /// 写动作未开放 / 未授权（§11.4，50720）。
    ActionDenied {
        action: GhAction,
        reason: DenyReason,
    },
    /// 写动作参数不合法（§11.4，50721）。
    BadActionParams {
        action: GhAction,
        field: String,
        detail: String,
    },
}

impl GhError {
    pub fn code(&self) -> u16 {
        match self {
            Self::NotInstalled => 50710,
            Self::NotLoggedIn => 50711,
            Self::RateLimited { .. } => 50712,
            Self::RepoUnavailable => 50713,
            Self::PrNotFound => 50716,
            Self::Timeout | Self::CliFailed { .. } => 50714,
            Self::ParseFailed { .. } => 50715,
            // 两种身份解析失败共用一个码：界面靠 key 区分「不是仓库」与「没远端」。
            Self::NotGitRepo { .. } | Self::NoRemote { .. } => 50717,
            Self::ActionDenied { .. } => 50720,
            Self::BadActionParams { .. } => 50721,
        }
    }
}

#[async_trait]
pub trait GhCli: Send + Sync {
    async fn status(&self) -> Result<GhStatus, GhError>;
    async fn viewer(&self) -> Result<Viewer, GhError>;
    async fn list_repos(
        &self,
        owner: Option<&str>,
        limit: u32,
    ) -> Result<Vec<RepoListing>, GhError>;
    async fn list_prs(&self, repo: &RepoRef, state: PrState) -> Result<Vec<PullRequest>, GhError>;
    async fn pr_detail(&self, repo: &RepoRef, number: u32) -> Result<PrDetail, GhError>;
    async fn pr_diff(&self, repo: &RepoRef, number: u32) -> Result<String, GhError>;
    async fn repo_meta(&self, repo: &RepoRef) -> Result<RepoMeta, GhError>;
    async fn repo_counts(&self, repo: &RepoRef) -> Result<RepoCounts, GhError>;
    async fn list_issues(
        &self,
        repo: &RepoRef,
        state: IssueState,
        limit: u32,
    ) -> Result<Vec<Issue>, GhError>;
    async fn list_releases(&self, repo: &RepoRef, limit: u32) -> Result<Vec<Release>, GhError>;
    async fn list_runs(&self, repo: &RepoRef, limit: u32) -> Result<Vec<WorkflowRun>, GhError>;
    async fn list_workflows(&self, repo: &RepoRef) -> Result<Vec<Workflow>, GhError>;
    async fn repo_tree(
        &self,
        repo: &RepoRef,
        path: Option<&str>,
        git_ref: Option<&str>,
    ) -> Result<Vec<TreeEntry>, GhError>;
    async fn capabilities(&self, repo: &RepoRef) -> Result<Vec<Capability>, GhError>;
    async fn action(
        &self,
        repo: &RepoRef,
        params: &GhActionParams,
    ) -> Result<ActionResult, GhError>;
}
