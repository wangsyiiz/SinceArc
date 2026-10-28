//! gh 命令层：DTO 映射与错误码/文案映射。

pub mod cli;
pub mod model;
pub mod service;

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::commands::CmdError;

use self::model::{GhCli, GhError, GhStatus};
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
}

impl From<GhStatus> for GhStatusDto {
    fn from(status: GhStatus) -> Self {
        Self {
            available: status.available,
            version: status.version,
            logged_in: status.logged_in,
            gh_path: status.gh_path,
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
        GhError::NotLoggedIn => {
            CmdError::keyed(code, "err.gh.notLoggedIn", "gh 还没登录 GitHub")
        }
        GhError::Timeout => failed(code, "超时（2s/5s）"),
        GhError::CliFailed { stderr } => failed(code, first_line(&stderr)),
        GhError::RateLimited { reset } => failed(code, format!("限流，reset {reset}")),
        GhError::RepoUnavailable => failed(code, "仓库不存在或没有权限"),
        GhError::ParseFailed { version } => failed(code, format!("解析失败（gh {version}）")),
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
