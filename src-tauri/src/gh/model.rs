//! gh 领域模型：与命令行参数、进程和 DTO 解耦。

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoRef {
    pub host: Option<String>,
    pub owner: String,
    pub name: String,
}

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
        }
    }
}

#[async_trait]
pub trait GhCli: Send + Sync {
    async fn status(&self) -> Result<GhStatus, GhError>;
    async fn list_prs(&self, repo: &RepoRef, state: PrState) -> Result<Vec<PullRequest>, GhError>;
    async fn pr_detail(&self, repo: &RepoRef, number: u32) -> Result<PrDetail, GhError>;
    async fn pr_diff(&self, repo: &RepoRef, number: u32) -> Result<String, GhError>;
}
