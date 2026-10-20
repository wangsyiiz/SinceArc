//! Tauri command 层：薄适配 —— 只做 DTO 转换与错误映射，不写业务逻辑。
//!
//! 错误统一走 `CmdError { code, msg }`：前端据 code 分支，msg 给人看。
//! 码位约定（sincearc 自己的小表，与 ACP 无关）：
//!   50100 尚未实现 / 50101 环境不满足（找不到程序等）
//!   50200 agent 启动或握手失败
//!   50300 状态不一致（未连接就调用等）

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::acp::launch::{AgentProfile, Launch};
use crate::acp::{self, transport};
use crate::state::{AgentHandle, AppState};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Serialize)]
pub struct CmdError {
    pub code: u32,
    pub msg: String,
}

impl CmdError {
    fn new(code: u32, msg: impl Into<String>) -> Self {
        Self {
            code,
            msg: msg.into(),
        }
    }
}

impl From<transport::TransportError> for CmdError {
    fn from(e: transport::TransportError) -> Self {
        Self::new(50200, e.to_string())
    }
}

/// 前端传来的 profile。字段与 `AgentProfile` 不同 —— 那是内部结构，
/// 这里只接 UI 真正会填的那几项。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileDto {
    pub id: String,
    pub name: String,
    /// "local" | "wsl" | "ssh"
    pub launch: String,
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: String,
    #[serde(default)]
    pub distro: Option<String>,
    #[serde(default)]
    pub shell: Option<String>,
    /// 仅 launch = "ssh" 时有值（E1.1 才实现）
    #[serde(default)]
    pub ssh_host: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectOutcome {
    pub agent_name: String,
    pub agent_version: String,
    pub protocol_version: i64,
    pub load_session: bool,
    pub image_prompts: bool,
    pub auth_methods: Vec<String>,
}

fn to_profile(dto: &ProfileDto) -> Result<AgentProfile, CmdError> {
    let launch = match dto.launch.as_str() {
        "local" => Launch::Local,
        "wsl" => Launch::Wsl {
            distro: dto.distro.clone().unwrap_or_else(|| "fedora".into()),
            shell: dto.shell.clone().unwrap_or_else(|| "zsh".into()),
        },
        // 类型与配置已经留好，argv 生成在 E1.1 落地；现在明确拒绝，
        // 不假装能用。
        "ssh" => {
            return Err(CmdError::new(
                50100,
                format!(
                    "SSH 通道尚未实现（E1.1）：{}",
                    dto.ssh_host.as_deref().unwrap_or("<未填主机>")
                ),
            ))
        }
        other => {
            return Err(CmdError::new(
                50300,
                format!("未知的连接方式：{other}（只接受 local / wsl / ssh）"),
            ))
        }
    };

    Ok(AgentProfile {
        id: dto.id.clone(),
        name: dto.name.clone(),
        launch,
        program: dto.program.clone(),
        args: dto.args.clone(),
        env: BTreeMap::new(),
        default_cwd: PathBuf::from(&dto.cwd),
    })
}

#[tauri::command]
pub async fn agent_connect(
    state: State<'_, AppState>,
    profile: ProfileDto,
) -> Result<ConnectOutcome, CmdError> {
    let id = profile.id.clone();
    let parsed = to_profile(&profile)?;

    // 重连语义：先摘掉旧的（幂等），再起新的。不静默复用旧进程 ——
    // 用户点「连接」就是想要一个新会话。
    if let Some(old) = state.take(&id).await {
        old.proc.kill().await;
    }

    let cwd = profile.cwd.clone();
    let (proc, mut incoming, outcome) = acp::initialize(&parsed, &cwd, HANDSHAKE_TIMEOUT)
        .await
        .map_err(|e| {
            tracing::warn!(target: "sincearc::ipc", profile = %id, error = %e, "handshake failed");
            CmdError::from(e)
        })?;

    // S1 阶段只把入站消息打到日志：S2 起接 Channel 转到界面。
    tokio::spawn(async move {
        while let Some(msg) = incoming.recv().await {
            match msg {
                transport::Incoming::Notification { method, params } => {
                    tracing::debug!(target: "sincearc::acp", %method, bytes = params.to_string().len(), "notification");
                }
                transport::Incoming::Request { id, method, .. } => {
                    tracing::warn!(target: "sincearc::acp", id, %method, "unhandled agent request (S2 起接线)");
                }
            }
        }
    });

    tracing::info!(
        target: "sincearc::ipc",
        profile = %id,
        agent = %outcome.agent_name,
        version = %outcome.agent_version,
        "connected"
    );

    state
        .insert(
            id,
            Arc::new(AgentHandle {
                proc: Arc::new(proc),
                outcome: outcome.clone(),
                profile: parsed,
            }),
        )
        .await;

    Ok(ConnectOutcome {
        agent_name: outcome.agent_name,
        agent_version: outcome.agent_version,
        protocol_version: outcome.protocol_version,
        load_session: outcome.load_session,
        image_prompts: outcome.image_prompts,
        auth_methods: outcome.auth_methods,
    })
}

#[tauri::command]
pub async fn agent_disconnect(state: State<'_, AppState>, profile_id: String) -> Result<(), CmdError> {
    match state.take(&profile_id).await {
        Some(handle) => {
            handle.proc.kill().await;
            tracing::info!(target: "sincearc::ipc", profile = %profile_id, "disconnected");
            Ok(())
        }
        // 断开一个没连的东西不算错误：调用方想要的结果（没有连接）已经成立
        None => Ok(()),
    }
}

#[tauri::command]
pub async fn agent_list_connected(state: State<'_, AppState>) -> Result<Vec<String>, CmdError> {
    Ok(state.ids().await)
}
