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
use tauri::ipc::Channel;
use tauri::State;

use crate::acp::launch::{AgentProfile, Launch, SshAuth, SshSpec};
use crate::acp::{self, transport};
use crate::state::{AgentHandle, AppState, SessionRecord};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// 推给界面的事件。UI 只认这个枚举，不直接看 ACP 的 JSON ——
/// 协议类型收敛在 acp 模块里（见 acp/mod.rs 的约束 1）。
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AcpEvent {
    /// 单向通知，例如 `session/update`
    Notification {
        method: String,
        params: serde_json::Value,
    },
    /// agent 发来的请求，需要回响应（S4 起接线）
    Request {
        id: u64,
        method: String,
        params: serde_json::Value,
    },
    /// 连接建立后的自检：前端收到它就说明事件通道是通的
    Hello,
    /// agent 进程的输出流关闭了
    Exited,
    /// 一轮 prompt 开始了（UI 用来进入生成态；此时还没有任何 chunk）
    PromptStarted { session_id: String },
    /// 一轮 prompt 正常结束（带 stopReason 等原始结果）
    PromptResult {
        session_id: String,
        result: serde_json::Value,
    },
    /// 一轮 prompt 失败（超时、进程没了、agent 报错）
    PromptFailed { session_id: String, msg: String },
}

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
    /// 仅 launch = "ssh" 时有值
    #[serde(default)]
    pub ssh_host: Option<String>,
    #[serde(default)]
    pub ssh_port: Option<u16>,
    #[serde(default)]
    pub ssh_user: Option<String>,
    /// "key" | "password"
    #[serde(default)]
    pub ssh_auth: Option<String>,
    #[serde(default)]
    pub ssh_key_path: Option<String>,
    /// 密码只在内存里过一手：不写配置、不落 SQLite
    #[serde(default)]
    pub ssh_password: Option<String>,
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

/// SSH 的必填项缺失时逐个点名，不给默认值 ——
/// 默认值会让「没填」和「填错了」拿到同一个结果。
fn to_ssh_spec(dto: &ProfileDto) -> Result<SshSpec, CmdError> {
    let host = dto
        .ssh_host
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| CmdError::new(50300, "SSH 主机未填"))?;
    let user = dto
        .ssh_user
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| CmdError::new(50300, "SSH 账号未填"))?;

    let auth = match dto.ssh_auth.as_deref() {
        Some("key") => {
            let path = dto
                .ssh_key_path
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| CmdError::new(50300, "认证方式选了私钥，但私钥路径未填"))?;
            SshAuth::Key {
                path: path.to_string(),
            }
        }
        Some("password") => {
            let secret = dto
                .ssh_password
                .as_deref()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| CmdError::new(50300, "认证方式选了密码，但密码未填"))?;
            SshAuth::Password {
                secret: secret.to_string(),
            }
        }
        Some(other) => {
            return Err(CmdError::new(
                50300,
                format!("未知的认证方式：{other}（只接受 key / password）"),
            ))
        }
        None => return Err(CmdError::new(50300, "SSH 认证方式未选")),
    };

    Ok(SshSpec {
        host: host.to_string(),
        port: dto.ssh_port.unwrap_or(22),
        user: user.to_string(),
        auth,
    })
}

pub fn to_profile(dto: &ProfileDto) -> Result<AgentProfile, CmdError> {
    let launch = match dto.launch.as_str() {
        "local" => Launch::Local,
        "wsl" => Launch::Wsl {
            distro: dto.distro.clone().unwrap_or_else(|| "fedora".into()),
            shell: dto.shell.clone().unwrap_or_else(|| "zsh".into()),
        },
        "ssh" => Launch::Ssh(to_ssh_spec(dto)?),
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
    on_event: Channel<AcpEvent>,
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

    // 入站消息逐条推给界面；channel 断了说明前端不要了，停掉转发即可。
    let events = on_event.clone();
    tokio::spawn(async move {
        while let Some(msg) = incoming.recv().await {
            let payload = match msg {
                transport::Incoming::Notification { method, params } => {
                    tracing::debug!(target: "sincearc::acp", %method, "notification");
                    AcpEvent::Notification { method, params }
                }
                transport::Incoming::Request { id, method, params } => {
                    tracing::debug!(target: "sincearc::acp", id, %method, "agent request");
                    AcpEvent::Request { id, method, params }
                }
            };
            tracing::info!(
                target: "sincearc::ipc",
                kind = %match &payload {
                    AcpEvent::Notification { method, .. } => format!("notification:{method}"),
                    AcpEvent::Request { method, .. } => format!("request:{method}"),
                    AcpEvent::Hello => "hello".to_string(),
                    AcpEvent::Exited => "exited".to_string(),
                    AcpEvent::PromptStarted { .. } => "promptStarted".to_string(),
                    AcpEvent::PromptResult { .. } => "promptResult".to_string(),
                    AcpEvent::PromptFailed { .. } => "promptFailed".to_string(),
                },
                "forward -> webview"
            );
            if events.send(payload).is_err() {
                tracing::warn!(
                    target: "sincearc::ipc",
                    "event channel closed (前端不再接收)，停止转发"
                );
                return;
            }
        }
        let _ = events.send(AcpEvent::Exited);
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
                events: on_event.clone(),
            }),
        )
        .await;

    // 自检：这条如果前端也没收到，问题在 Channel 本身而不是 ACP 事件
    tracing::info!(target: "sincearc::ipc", "hello -> webview");
    if on_event.send(AcpEvent::Hello).is_err() {
        tracing::warn!(target: "sincearc::ipc", "hello event rejected：Channel 不可用");
    }

    Ok(ConnectOutcome {
        agent_name: outcome.agent_name,
        agent_version: outcome.agent_version,
        protocol_version: outcome.protocol_version,
        load_session: outcome.load_session,
        image_prompts: outcome.image_prompts,
        auth_methods: outcome.auth_methods,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
}

/// 新建会话。`cwd` 属于 agent 所在的世界（WSL/SSH 是 `/home/...`）。
#[tauri::command]
pub async fn session_new(
    state: State<'_, AppState>,
    profile_id: String,
    cwd: String,
) -> Result<SessionInfo, CmdError> {
    let handle = state
        .get(&profile_id)
        .await
        .ok_or_else(|| CmdError::new(50300, format!("profile 未连接，不能建会话：{profile_id}")))?;

    let result = handle
        .proc
        .request(
            "session/new",
            serde_json::json!({ "cwd": cwd, "mcpServers": [] }),
            REQUEST_TIMEOUT,
        )
        .await?;

    let session_id = result
        .get("sessionId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            CmdError::new(
                50200,
                format!("session/new 没有返回 sessionId，实际返回：{result}"),
            )
        })?
        .to_string();

    tracing::info!(target: "sincearc::ipc", profile = %profile_id, session = %session_id, "session created");
    state
        .insert_session(session_id.clone(), SessionRecord { profile_id, cwd })
        .await;

    Ok(SessionInfo { session_id })
}

const PROMPT_TIMEOUT: Duration = Duration::from_secs(600);

/// 发一轮消息。**立即返回** —— 流式内容走 `session/update` 通知，
/// 结束信号走 `PromptResult` / `PromptFailed` 事件。
/// 这里不 await 那一轮，否则 UI 会把整个生成过程当一次卡顿。
#[tauri::command]
pub async fn session_prompt(
    state: State<'_, AppState>,
    session_id: String,
    text: String,
) -> Result<(), CmdError> {
    if text.trim().is_empty() {
        return Err(CmdError::new(50300, "消息为空"));
    }

    let record = state
        .session(&session_id)
        .await
        .ok_or_else(|| CmdError::new(50300, format!("未知会话：{session_id}")))?;
    let handle = state.get(&record.profile_id).await.ok_or_else(|| {
        CmdError::new(
            50300,
            format!("会话所属的 profile 已断开：{}", record.profile_id),
        )
    })?;

    let params = serde_json::json!({
        "sessionId": session_id,
        "prompt": [{ "type": "text", "text": text }],
    });

    tracing::info!(
        target: "sincearc::ipc",
        session = %session_id,
        chars = text.chars().count(),
        "prompt sent"
    );

    let sid = session_id.clone();
    let events = handle.events.clone();
    let proc = handle.proc.clone();

    tokio::spawn(async move {
        // 先告诉界面「这一轮开始了」，UI 据此进入生成态
        tracing::info!(target: "sincearc::ipc", "forward -> webview kind=promptStarted");
        let _ = events.send(AcpEvent::PromptStarted {
            session_id: sid.clone(),
        });

        match proc.request("session/prompt", params, PROMPT_TIMEOUT).await {
            Ok(result) => {
                tracing::info!(target: "sincearc::ipc", session = %sid, stop = ?result.get("stopReason"), "prompt finished");
                tracing::info!(target: "sincearc::ipc", "forward -> webview kind=promptResult");
                let _ = events.send(AcpEvent::PromptResult {
                    session_id: sid,
                    result,
                });
            }
            Err(e) => {
                tracing::warn!(target: "sincearc::ipc", session = %sid, error = %e, "prompt failed");
                tracing::info!(target: "sincearc::ipc", "forward -> webview kind=promptFailed");
                let _ = events.send(AcpEvent::PromptFailed {
                    session_id: sid,
                    msg: e.to_string(),
                });
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn agent_disconnect(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<(), CmdError> {
    // 会话跟着进程一起死：先摘记录，别让 prompt 打到已关闭的进程上
    let dead = state.drop_sessions_of(&profile_id).await;
    if !dead.is_empty() {
        tracing::info!(target: "sincearc::ipc", profile = %profile_id, sessions = dead.len(), "drop sessions on disconnect");
    }

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
