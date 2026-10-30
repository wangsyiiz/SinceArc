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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GhError {
    NotInstalled,
    NotLoggedIn,
    RateLimited { reset: String },
    RepoUnavailable,
    PrNotFound,
    Timeout,
    CliFailed { stderr: String },
    ParseFailed { version: String },
    /// 从本地路径向上找不到 `.git`（docs/gh.md §2.1 第 1 步）。
    NotGitRepo { path: String },
    /// 找到 git 仓库但没有可用远端，或远端地址认不出（§2.1 第 3–4 步）。
    NoRemote { path: String, detail: String },
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
}
