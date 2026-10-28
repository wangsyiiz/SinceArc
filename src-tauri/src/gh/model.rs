//! gh 领域模型：与命令行参数、进程和 DTO 解耦。

use async_trait::async_trait;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GhStatus {
    pub available: bool,
    pub version: Option<String>,
    pub logged_in: bool,
    pub gh_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GhError {
    NotInstalled,
    NotLoggedIn,
    RateLimited { reset: String },
    RepoUnavailable,
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
            Self::Timeout | Self::CliFailed { .. } => 50714,
            Self::ParseFailed { .. } => 50715,
        }
    }
}

#[async_trait]
pub trait GhCli: Send + Sync {
    async fn status(&self) -> Result<GhStatus, GhError>;
}
