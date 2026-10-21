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
use crate::db;
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
#[derive(Debug, Clone, Serialize, Deserialize)]
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
    pub default_mode: Option<String>,
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
    /// 本次连接落到的会话：复用了旧的就还是旧的，没有就新建。
    /// 前端直接用它，不必再发一次 session/new（那样每连一次就多一个空会话）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub modes: Option<acp::SessionModes>,
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
            id.clone(),
            Arc::new(AgentHandle {
                proc: Arc::new(proc),
                outcome: outcome.clone(),
                profile: parsed,
                events: on_event.clone(),
            }),
        )
        .await;

    // 会话归属：优先复用上次的（agent 侧因此不会每连一次就多一个空会话）
    let handle = state.get(&id).await.expect("just inserted");
    let (session_id, modes) = match attach_session(&state, &id, &handle, &cwd).await {
        Some((session_id, modes)) => (Some(session_id), modes),
        None => (None, None),
    };

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
        session_id,
        modes,
    })
}

/// 连上之后把会话定下来：能 load 就 load，不能就 new。
///
/// 返回会话 id；两步都失败时返回 None（连接本身仍然算成功 ——
/// 握手通了就是通了，会话建不起来是另一件事，前端会拿到 None）。
async fn attach_session(
    state: &AppState,
    profile_id: &str,
    handle: &AgentHandle,
    cwd: &str,
) -> Option<(String, Option<acp::SessionModes>)> {
    let mut warnings: Vec<String> = Vec::new();

    if handle.outcome.load_session {
        match state.db.last_acp_session(profile_id) {
            Ok(Some(prev)) => {
                let params = serde_json::json!({
                    "sessionId": prev,
                    "cwd": cwd,
                    "mcpServers": [],
                });
                match handle
                    .proc
                    .request("session/load", params, Duration::from_secs(120))
                    .await
                {
                    Ok(v) => {
                        let modes = acp::modes_from_response(&v);
                        if let Some(m) = &modes {
                            state.set_modes(prev.clone(), m.clone()).await;
                        }
                        tracing::info!(
                            target: "sincearc::ipc",
                            session = %prev,
                            "session resumed"
                        );
                        state
                            .insert_session(
                                prev.clone(),
                                SessionRecord {
                                    profile_id: profile_id.to_string(),
                                    cwd: cwd.to_string(),
                                },
                            )
                            .await;
                        return Some((prev, modes));
                    }
                    Err(e) => {
                        tracing::warn!(
                            target: "sincearc::ipc",
                            session = %prev,
                            error = %e,
                            "session/load failed, creating a new one"
                        );
                        warnings.push(format!("load {prev}: {e}"));
                    }
                }
            }
            Ok(None) => {}
            Err(e) => tracing::warn!(target: "sincearc::ipc", error = %e, "读取会话记录失败"),
        }
    }

    let created = handle
        .proc
        .request(
            "session/new",
            serde_json::json!({ "cwd": cwd, "mcpServers": [] }),
            Duration::from_secs(120),
        )
        .await;

    match created {
        Ok(v) => {
            let sid = v["sessionId"].as_str()?.to_string();
            let modes = acp::modes_from_response(&v);
            if let Some(m) = &modes {
                state.set_modes(sid.clone(), m.clone()).await;
            }
            tracing::info!(target: "sincearc::ipc", session = %sid, "session created");
            state
                .insert_session(
                    sid.clone(),
                    SessionRecord {
                        profile_id: profile_id.to_string(),
                        cwd: cwd.to_string(),
                    },
                )
                .await;
            Some((sid, modes))
        }
        Err(e) => {
            tracing::warn!(target: "sincearc::ipc", error = %e, "session/new failed");
            // 上次 load 失败的线索留在日志里，别让它只在内存里闪一下
            for w in warnings {
                tracing::warn!(target: "sincearc::ipc", "previous attempt: {w}");
            }
            None
        }
    }
}

#[tauri::command]
pub async fn profiles_load(state: State<'_, AppState>) -> Result<Vec<ProfileDto>, CmdError> {
    state
        .db
        .load_profiles()
        .map_err(|e| CmdError::new(50000, format!("读取配置失败：{e}")))
}

#[tauri::command]
pub async fn profiles_save(
    state: State<'_, AppState>,
    profiles: Vec<ProfileDto>,
) -> Result<(), CmdError> {
    // 密码永不落盘：这里再剥一次，别指望前端记得
    let sanitized: Vec<ProfileDto> = profiles
        .into_iter()
        .map(|p| ProfileDto {
            ssh_password: None,
            ..p
        })
        .collect();
    state
        .db
        .save_profiles(&sanitized)
        .map_err(|e| CmdError::new(50000, format!("保存配置失败：{e}")))
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

    // 任何建立 ACP 会话的路径都要留一份 modes 快照 —— 否则 session_apply_mode
    // 拿不到可选列表，只能按「不推」处理（规范 §4 兜底），用户设了什么都不会生效。
    if let Some(modes) = acp::modes_from_response(&result) {
        state.set_modes(session_id.clone(), modes).await;
    }

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

/* ---------------- 会话与消息的读写 ---------------- */

#[tauri::command]
pub async fn sessions_list(
    state: State<'_, AppState>,
    profile_id: Option<String>,
) -> Result<Vec<db::SessionRow>, CmdError> {
    state
        .db
        .list_sessions(profile_id.as_deref())
        .map_err(|e| CmdError::new(50000, format!("读取会话列表失败：{e}")))
}

#[tauri::command]
pub async fn session_upsert(
    state: State<'_, AppState>,
    row: db::SessionRow,
) -> Result<(), CmdError> {
    state
        .db
        .upsert_session(&row)
        .map_err(|e| CmdError::new(50000, format!("保存会话失败：{e}")))
}

#[tauri::command]
pub async fn session_delete(state: State<'_, AppState>, id: String) -> Result<(), CmdError> {
    state
        .db
        .delete_session(&id)
        .map_err(|e| CmdError::new(50000, format!("删除会话失败：{e}")))
}

#[tauri::command]
pub async fn session_bind_acp(
    state: State<'_, AppState>,
    id: String,
    acp_session_id: String,
) -> Result<(), CmdError> {
    state
        .db
        .bind_acp_session(&id, &acp_session_id)
        .map_err(|e| CmdError::new(50000, format!("绑定会话失败：{e}")))
}

#[tauri::command]
pub async fn messages_append(
    state: State<'_, AppState>,
    session_id: String,
    messages: Vec<db::MessageInput>,
) -> Result<(), CmdError> {
    state
        .db
        .append_messages(&session_id, &messages)
        .map_err(|e| CmdError::new(50000, format!("保存消息失败：{e}")))
}

#[tauri::command]
pub async fn messages_load(
    state: State<'_, AppState>,
    session_id: String,
    limit: Option<i64>,
) -> Result<Vec<db::MessageRow>, CmdError> {
    state
        .db
        .load_messages(&session_id, limit.unwrap_or(200))
        .map_err(|e| CmdError::new(50000, format!("读取消息失败：{e}")))
}

/* ---------------- 会话审批模式（编辑审批） ---------------- */
// 判据与顺序见 docs/modes-spec.md §4 / §5.1。两条铁律：
//   1. 手动选择：校验通过、且 set_mode 成功之后，才写 mode_override
//   2. 没有目标值 / 连接不支持 → 一律「不推」，不猜一个值推上去
// 错误码分区（规范 §6 要求把「配置问题」和「运行期失败」分开）：
//   50400 连接已断开   50401 连接不支持该模式   50402 set_mode 调用失败   50403 会话没报上来可选模式

/// 一次模式动作的结果。`Ok` 表示存储层已按用户意图写好；`warning` 说明为什么没推成。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeChoice {
    /// 这次真正推给 agent 并成功的模式；None = 没推
    pub applied: Option<String>,
    /// 动作完成后该会话是否处于「跟随连接默认」
    pub following: bool,
    /// 没推成的原因（配置问题，不是运行期错误）
    pub warning: Option<String>,
}

impl ModeChoice {
    fn skipped(following: bool, why: impl Into<String>) -> Self {
        Self {
            applied: None,
            following,
            warning: Some(why.into()),
        }
    }
}

/// 读连接的默认模式。profile 不在库里就按「没设置」处理 ——
/// 配置可能刚被删掉，这时不该拦住会话层面的动作。
fn profile_default_mode(state: &AppState, profile_id: &str) -> Option<String> {
    state
        .db
        .load_profiles()
        .ok()?
        .into_iter()
        .find(|p| p.id == profile_id)?
        .default_mode
}

/// 把模式推给 agent。失败一律是运行期错误。
async fn push_mode(
    handle: &AgentHandle,
    acp_session_id: &str,
    mode_id: &str,
) -> Result<(), CmdError> {
    handle
        .proc
        .request(
            "session/set_mode",
            serde_json::json!({ "sessionId": acp_session_id, "modeId": mode_id }),
            Duration::from_secs(60),
        )
        .await
        .map(|_| {
            // 成功路径也要留痕：界面显示是一回事，日志能证明「我们确实推了这个值」
            tracing::info!(
                target: "sincearc::ipc",
                session = acp_session_id,
                mode = mode_id,
                "mode pushed"
            );
        })
        .map_err(|e| {
            tracing::warn!(
                target: "sincearc::ipc",
                session = acp_session_id,
                mode = mode_id,
                error = %e,
                "set_mode failed"
            );
            CmdError::new(
                50402,
                format!("切换模式失败：{mode_id}（该连接可能不支持这个模式）"),
            )
        })
}

/// 打开/恢复会话之后按存储推一次值（规范 §4）。**不写存储** ——
/// 它只负责把已经记下的意图落到 agent 上，意图本身由 session_choose_mode 写。
#[tauri::command]
pub async fn session_apply_mode(
    state: State<'_, AppState>,
    profile_id: String,
    acp_session_id: String,
    ui_session_id: String,
) -> Result<ModeChoice, CmdError> {
    let override_mode = state
        .db
        .mode_override(&ui_session_id)
        .map_err(|e| CmdError::new(50000, format!("读取会话模式失败：{e}")))?;
    let following = override_mode.is_none();

    // 兜底（§4 末条）：两个来源都空就什么都不推，沿用 agent 报的 currentModeId
    let Some(target) = override_mode.or_else(|| profile_default_mode(&state, &profile_id)) else {
        return Ok(ModeChoice {
            applied: None,
            following,
            warning: None,
        });
    };

    let Some(modes) = state.modes_of(&acp_session_id).await else {
        return Ok(ModeChoice::skipped(
            following,
            "这个会话没有报上来可选模式，按不推处理",
        ));
    };
    if !modes.available.iter().any(|m| m.id == target) {
        return Ok(ModeChoice::skipped(
            following,
            format!("该连接不支持模式 {target}，已保留你的设置"),
        ));
    }

    let handle = state
        .get(&profile_id)
        .await
        .ok_or_else(|| CmdError::new(50400, "连接已断开，改不了模式"))?;
    match push_mode(&handle, &acp_session_id, &target).await {
        Ok(()) => Ok(ModeChoice {
            applied: Some(target),
            following,
            warning: None,
        }),
        // 打开会话时的推送失败不该让整个连接流程失败：降级成 warning，界面显示即可
        Err(e) => Ok(ModeChoice::skipped(
            following,
            format!("推送模式 {target} 失败：{}", e.msg),
        )),
    }
}

/// 用户在会话内改模式（规范 §5.1）。`mode_id` 为 None = 改回「跟随连接默认」。
///
/// 手动选择走「校验 → 推 agent → 成功才落库」；先落库会让 agent 拒绝时
/// 留下一个从没生效过的值，下次打开再失败一次。
#[tauri::command]
pub async fn session_choose_mode(
    state: State<'_, AppState>,
    profile_id: String,
    acp_session_id: String,
    ui_session_id: String,
    mode_id: Option<String>,
) -> Result<ModeChoice, CmdError> {
    let handle = state
        .get(&profile_id)
        .await
        .ok_or_else(|| CmdError::new(50400, "连接已断开，改不了模式"))?;

    match mode_id {
        Some(m) => {
            // 用户当场选的：不支持就当场拒绝，一个字节都不写
            let modes = state
                .modes_of(&acp_session_id)
                .await
                .ok_or_else(|| CmdError::new(50403, "这个会话没有报上来可选模式，无法切换"))?;
            if !modes.available.iter().any(|x| x.id == m) {
                return Err(CmdError::new(50401, format!("这个连接不支持模式 {m}")));
            }
            push_mode(&handle, &acp_session_id, &m).await?;
            state
                .db
                .set_mode_override(&ui_session_id, Some(&m))
                .map_err(|e| CmdError::new(50000, format!("保存会话模式失败：{e}")))?;
            Ok(ModeChoice {
                applied: Some(m),
                following: false,
                warning: None,
            })
        }
        None => {
            // 改回跟随：记账的是「跟随」这个意图本身，不是某个值，
            // 所以即便后面推不动也照记 —— 不违反 §5.1 的「先切成功再落库」
            state
                .db
                .set_mode_override(&ui_session_id, None)
                .map_err(|e| CmdError::new(50000, format!("保存会话模式失败：{e}")))?;

            let Some(target) = profile_default_mode(&state, &profile_id) else {
                return Ok(ModeChoice {
                    applied: None,
                    following: true,
                    warning: None,
                });
            };
            let Some(modes) = state.modes_of(&acp_session_id).await else {
                return Ok(ModeChoice::skipped(
                    true,
                    "这个会话没有报上来可选模式，按不推处理",
                ));
            };
            if !modes.available.iter().any(|x| x.id == target) {
                return Ok(ModeChoice::skipped(
                    true,
                    format!("连接默认模式 {target} 不受此连接支持"),
                ));
            }
            match push_mode(&handle, &acp_session_id, &target).await {
                Ok(()) => Ok(ModeChoice {
                    applied: Some(target),
                    following: true,
                    warning: None,
                }),
                Err(e) => Ok(ModeChoice::skipped(
                    true,
                    format!("推送模式 {target} 失败：{}", e.msg),
                )),
            }
        }
    }
}
