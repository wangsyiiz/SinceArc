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
    /// 握手报上来的协议能力键（loadSession / image / list / fork …）。
    /// 通用客户端靠它显示「这个 agent 支持什么」，而不是按名字查表。
    pub capabilities: Vec<String>,
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

/// 起进程之前的静态校验。
///
/// 这些错误以前都会掉进 50200「启动或握手失败」那个兜底码里，用户看到的是一句
/// 「agent closed stdout」—— 空 cwd 和命令不存在长得一模一样，根本没法排查。
fn validate_launch_input(profile: &ProfileDto) -> Result<(), CmdError> {
    if profile.program.trim().is_empty() {
        return Err(CmdError::new(
            50202,
            "agent 命令为空：先在「Agent」里选一个，或填一条能起 ACP 的命令",
        ));
    }
    if profile.cwd.trim().is_empty() {
        return Err(CmdError::new(
            50201,
            "工作目录为空：agent 会在空路径下启动并立刻退出，先把工作目录填上",
        ));
    }
    Ok(())
}

/// 把「起不来」的原因连同**跑的是什么命令、在哪个目录**一起报出去。
fn launch_error(profile: &ProfileDto, e: transport::TransportError) -> CmdError {
    let cmd = std::iter::once(profile.program.as_str())
        .chain(profile.args.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join(" ");
    CmdError::new(
        50200,
        format!(
            "启动失败：`{cmd}`（{} · 工作目录 {}）
{e}",
            profile.launch, profile.cwd
        ),
    )
}

/// 探测一条连接配置能不能起 ACP agent。
///
/// 只做握手，不留进程 —— 设置页要回答的是「这条命令到底是不是 ACP agent」，
/// 这件事只有真跑一次 initialize 才算证明过，靠命令名猜是猜不出来的。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeOutcome {
    pub agent_name: String,
    pub agent_version: String,
    pub protocol_version: i64,
    pub load_session: bool,
    /// 握手报上来的能力键（拍平后）。探测的价值一半在这里：
    /// 用户能**在保存连接之前**知道这个 agent 支不支持恢复会话 / 图片 / fork。
    pub capabilities: Vec<String>,
}

/* ---------- 群聊成员（docs/group-chat.md） ---------- */

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUserTestOutcome {
    pub ok: bool,
    /// 成功时是 agent 报回来的会话信息，失败时是**原因**（不是「失败」两个字）
    pub detail: String,
}

/// 测试一个 sessionId 能不能当玩家的锚点。
///
/// 规范 §2：必须真跑 `session/load`，不能用 `session/list` 判断 —— list 只返回 agent 记着的列表，
/// 既未必与用户输入一致，也判不出「这个 id 能不能恢复」。
#[tauri::command]
pub async fn agent_user_test(
    profile: ProfileDto,
    acp_session_id: String,
    cwd: Option<String>,
) -> Result<AgentUserTestOutcome, CmdError> {
    validate_launch_input(&profile)?;
    if acp_session_id.trim().is_empty() {
        return Err(CmdError::new(50602, "session id 不能为空"));
    }
    let parsed = to_profile(&profile)?;
    let cwd = cwd
        .filter(|c| !c.trim().is_empty())
        .unwrap_or_else(|| profile.cwd.clone());
    let (proc, _incoming, outcome) = acp::initialize(&parsed, &cwd, Duration::from_secs(20))
        .await
        .map_err(|e| launch_error(&profile, e))?;

    if !outcome.load_session {
        proc.kill().await;
        return Ok(AgentUserTestOutcome {
            ok: false,
            detail: format!(
                "{} 没报 loadSession 能力，恢复不了已有会话 —— 换个 sessionId 没用，这条连接起不了玩家",
                outcome.agent_name
            ),
        });
    }

    let params = serde_json::json!({
        "sessionId": acp_session_id,
        "cwd": cwd,
        "mcpServers": [],
    });
    let res = proc
        .request("session/load", params, Duration::from_secs(120))
        .await;
    proc.kill().await;

    match res {
        Ok(v) => {
            tracing::info!(
                target: "sincearc::ipc", session = %acp_session_id,
                agent = %outcome.agent_name, "agent user test ok"
            );
            Ok(AgentUserTestOutcome {
                ok: true,
                detail: describe_loaded_session(&v, &outcome.agent_name),
            })
        }
        Err(e) => Ok(AgentUserTestOutcome {
            ok: false,
            detail: format!("session/load 失败：{e}"),
        }),
    }
}

/// 把 session/load 的响应说成人话：尽量给出「恢复了什么」，而不是「成功」。
fn describe_loaded_session(v: &serde_json::Value, agent: &str) -> String {
    let modes = acp::modes_from_response(v);
    let mode = modes
        .as_ref()
        .map(|m| m.current.clone())
        .unwrap_or_else(|| "未报".into());
    format!("已恢复到 {agent} 的会话（当前模式 {mode}）")
}

#[tauri::command]
pub fn agent_users_list(
    state: State<'_, AppState>,
) -> Result<Vec<crate::db::AgentUserRow>, CmdError> {
    state
        .db
        .list_agent_users()
        .map_err(|e| CmdError::new(50000, format!("读 agent user 失败：{e}")))
}

/// 保存玩家。handle 与 (连接, 会话) 都是唯一键 —— 冲突要说清楚是哪一个，
/// 否则用户只会看到一句 SQLite 的英文。
#[tauri::command]
pub fn agent_user_save(
    state: State<'_, AppState>,
    user: crate::db::AgentUserRow,
) -> Result<(), CmdError> {
    if user.name.trim().is_empty() {
        return Err(CmdError::new(50602, "名字不能为空"));
    }
    if user.handle.trim().trim_start_matches('@').is_empty() {
        return Err(CmdError::new(50602, "handle 不能为空"));
    }
    if user.acp_session_id.trim().is_empty() {
        return Err(CmdError::new(
            50602,
            "session id 不能为空：先测试通过再保存",
        ));
    }
    match state.db.upsert_agent_user(&user) {
        Ok(()) => Ok(()),
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("agent_users.handle") {
                Err(CmdError::new(
                    50600,
                    format!("@{} 已经被占用了", user.handle.trim_start_matches('@')),
                ))
            } else if msg.contains("profile_id, acp_session_id") {
                Err(CmdError::new(
                    50601,
                    "这条连接上这个会话已经是另一个玩家了 —— 同一个人不能同时有两个身份",
                ))
            } else {
                Err(CmdError::new(50000, format!("保存失败：{msg}")))
            }
        }
    }
}

#[tauri::command]
pub fn agent_user_delete(state: State<'_, AppState>, id: String) -> Result<(), CmdError> {
    state
        .db
        .delete_agent_user(&id)
        .map_err(|e| CmdError::new(50000, format!("删除失败：{e}")))
}

#[tauri::command]
pub fn session_members(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<crate::db::AgentUserRow>, CmdError> {
    state
        .db
        .session_members(&session_id)
        .map_err(|e| CmdError::new(50000, format!("读群成员失败：{e}")))
}

#[tauri::command]
pub fn session_member_add(
    state: State<'_, AppState>,
    session_id: String,
    user_id: String,
) -> Result<(), CmdError> {
    state
        .db
        .add_member(&session_id, &user_id)
        .map_err(|e| CmdError::new(50000, format!("拉人进群失败：{e}")))
}

#[tauri::command]
pub fn session_member_remove(
    state: State<'_, AppState>,
    session_id: String,
    user_id: String,
) -> Result<(), CmdError> {
    state
        .db
        .remove_member(&session_id, &user_id)
        .map_err(|e| CmdError::new(50000, format!("移出群失败：{e}")))
}

/// SSH 只扫**用户已经存了连接配置**的 host（docs/discovery.md §3）。
///
/// 不去扫未知主机：那会和用户的 known_hosts 打架，而且可能是别人的机器。
/// 复用启动层（同一个 ssh 命令、同一套 askpass/密钥处理），只是把远端命令换成扫描脚本 ——
/// 这样密码档也能扫，不用为探测单写一套认证。
async fn scan_ssh(profiles: &[ProfileDto]) -> (Vec<acp::discover::Found>, Vec<String>) {
    let mut found = Vec::new();
    let mut warnings = Vec::new();
    for p in profiles.iter().filter(|p| p.launch == "ssh") {
        let label = p
            .ssh_host
            .clone()
            .filter(|h| !h.trim().is_empty())
            .unwrap_or_else(|| p.name.clone());
        if label.trim().is_empty() {
            continue; // 没填 host 的连接本来就没配好，不必当成扫描失败
        }
        let mut probe = p.clone();
        probe.program = "sh".into();
        // 脚本走 stdin（`sh -s`），不拼进远端命令行：
        // 多行脚本里既有单引号又有双引号，穿一层 Windows 参数转义再加一层远端 shell 解析，
        // 太容易被打散（WSL 那条路径就是这么踩的，见 discover::scan_script 注释）。
        probe.args = vec!["-s".into()];
        if probe.cwd.trim().is_empty() {
            probe.cwd = "/tmp".into(); // cd '' 会失败；探测不关心目录，只要起得来
        }
        let parsed = match to_profile(&probe) {
            Ok(x) => x,
            Err(e) => {
                warnings.push(format!("{label} 未扫描：{} {}", e.code, e.msg));
                continue;
            }
        };
        let spec = match parsed.command_line(&probe.cwd) {
            Ok(x) => x,
            Err(e) => {
                warnings.push(format!("{label} 未扫描：{e}"));
                continue;
            }
        };
        let mut cmd = tokio::process::Command::new(&spec.program);
        cmd.args(&spec.args);
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000);
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                if let Some(c) = spec.cleanup {
                    let _ = std::fs::remove_file(c);
                }
                warnings.push(format!("{label} 未扫描：{e}"));
                continue;
            }
        };
        if let Some(mut si) = child.stdin.take() {
            use tokio::io::AsyncWriteExt;
            let _ = si.write_all(acp::discover::scan_script().as_bytes()).await;
            drop(si); // 显式关：sh -s 读到 EOF 才开始跑
        }
        let out =
            match tokio::time::timeout(Duration::from_secs(25), child.wait_with_output()).await {
                Ok(Ok(o)) => o,
                Ok(Err(e)) => {
                    if let Some(c) = spec.cleanup {
                        let _ = std::fs::remove_file(c);
                    }
                    warnings.push(format!("{label} 未扫描：{e}"));
                    continue;
                }
                Err(_) => {
                    warnings.push(format!("{label} 未扫描：25 秒超时"));
                    continue;
                }
            };
        if let Some(c) = spec.cleanup {
            let _ = std::fs::remove_file(c);
        }
        if !out.status.success() {
            warnings.push(format!(
                "{label} 未扫描：退出码 {:?} {}",
                out.status.code(),
                String::from_utf8_lossy(&out.stderr)
                    .lines()
                    .next()
                    .unwrap_or("")
            ));
            continue;
        }
        let (home, hits) = acp::discover::parse_scan_output(&String::from_utf8_lossy(&out.stdout));
        for (bin, path) in hits {
            if let Some(c) = acp::discover::CANDIDATES.iter().find(|c| c.binary == bin) {
                found.push(acp::discover::Found {
                    candidate_id: c.id.to_string(),
                    host: format!("ssh:{label}"),
                    path,
                    home: home.clone(),
                });
            }
        }
    }
    (found, warnings)
}

/// 本机 + WSL + 已存连接的 SSH，一次扫完。
/// 命令与测试都走这里，避免「测试验的是一条路、界面跑的是另一条」。
async fn discover_all(ssh_profiles: Vec<ProfileDto>) -> acp::discover::DiscoverOutcome {
    let mut outcome = acp::discover::scan().await;
    if !ssh_profiles.is_empty() {
        let (hits, warns) = scan_ssh(&ssh_profiles).await;
        outcome.found.extend(hits);
        outcome.warnings.extend(warns);
    }
    outcome
}

/// 测试入口：不起 Tauri、不写缓存。
pub async fn agent_discover_for_test(
    ssh_profiles: Vec<ProfileDto>,
) -> acp::discover::DiscoverOutcome {
    discover_all(ssh_profiles).await
}

/// 扫一遍机器：哪些 agent 能当 ACP 服务端跑（docs/discovery.md）。
///
/// 只负责「找人」——发现到 `codex` 不等于它能起 ACP（实测 codex 没有 acp 子命令，
/// 要靠 codex-acp 适配器）。「能不能真握手」交给 `agent_probe`。
#[tauri::command]
pub async fn agent_discover(
    state: State<'_, AppState>,
    ssh_profiles: Option<Vec<ProfileDto>>,
) -> Result<acp::discover::DiscoverOutcome, CmdError> {
    let outcome = discover_all(ssh_profiles.unwrap_or_default()).await;
    tracing::info!(
        target: "sincearc::ipc", hits = outcome.found.len(),
        warnings = outcome.warnings.len(), "discovery finished"
    );
    // 缓存失败不影响这次结果：用户要看的是扫描结果，不是写库是否成功
    if let Ok(json) = serde_json::to_string(&outcome.into_cache()) {
        if let Err(e) = state.db.meta_set("discovery", &json) {
            tracing::warn!(target: "sincearc::ipc", error = %e, "discovery cache write failed");
        }
    }
    Ok(outcome)
}

/// 读上一次扫描的缓存（启动时先渲染，不必等扫描）。
#[tauri::command]
pub fn agent_discovery_cached(
    state: State<'_, AppState>,
) -> Result<Option<acp::discover::DiscoverOutcome>, CmdError> {
    let raw = state
        .db
        .meta_get("discovery")
        .map_err(|e| CmdError::new(50000, format!("读发现缓存失败：{e}")))?;
    let Some(raw) = raw else { return Ok(None) };
    match serde_json::from_str::<acp::discover::DiscoveryCache>(&raw) {
        Ok(c) => Ok(Some(acp::discover::DiscoverOutcome::from_cache(c))),
        Err(e) => {
            // 缓存格式变了（升级过）：当成没扫过，让用户重扫，不要报错卡住启动
            tracing::warn!(target: "sincearc::ipc", error = %e, "discovery cache unreadable, ignoring");
            Ok(None)
        }
    }
}

#[tauri::command]
pub async fn agent_probe(profile: ProfileDto) -> Result<ProbeOutcome, CmdError> {
    validate_launch_input(&profile)?;
    let parsed = to_profile(&profile)?;
    let cwd = profile.cwd.clone();
    // 比正常连接短：用户点了「探测」就在等结果，等太久不如直接报错
    let (proc, _incoming, outcome) = acp::initialize(&parsed, &cwd, Duration::from_secs(20))
        .await
        .map_err(|e| {
            tracing::warn!(
                target: "sincearc::ipc", profile = %profile.id, program = %profile.program,
                cwd = %profile.cwd, error = %e, "probe failed"
            );
            launch_error(&profile, e)
        })?;
    proc.kill().await;
    tracing::info!(
        target: "sincearc::ipc", profile = %profile.id,
        agent = %outcome.agent_name, version = %outcome.agent_version,
        "probe ok"
    );
    Ok(ProbeOutcome {
        agent_name: outcome.agent_name,
        agent_version: outcome.agent_version,
        protocol_version: outcome.protocol_version,
        load_session: outcome.load_session,
        capabilities: outcome.capabilities,
    })
}

#[tauri::command]
pub async fn agent_connect(
    state: State<'_, AppState>,
    profile: ProfileDto,
    on_event: Channel<AcpEvent>,
) -> Result<ConnectOutcome, CmdError> {
    let id = profile.id.clone();
    validate_launch_input(&profile)?;
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
            launch_error(&profile, e)
        })?;

    // 入站消息逐条推给界面；channel 断了说明前端不要了，停掉转发即可。
    let events = on_event.clone();
    // 转发 task 里拿不到 State，所以把进程句柄和「待回答登记表」clone 进去：
    // 未实现的方法要在这里当场拒答，权限请求要在这里登记 id。
    let proc = Arc::new(proc);
    let proc_for_task = proc.clone();
    let pending = state.pending.clone();
    let profile_for_task = id.clone();
    tokio::spawn(async move {
        while let Some(msg) = incoming.recv().await {
            let payload = match msg {
                transport::Incoming::Notification { method, params } => {
                    tracing::debug!(target: "sincearc::acp", %method, "notification");
                    AcpEvent::Notification { method, params }
                }
                transport::Incoming::Request { id, method, params } => {
                    tracing::debug!(target: "sincearc::acp", id, %method, "agent request");
                    if method != "session/request_permission" {
                        // 没实现的方法必须当场拒答。JSON-RPC 里一个不回的请求会让 agent
                        // 一直等（hermes 默认 300s 才自拒），而界面上什么都不显示 ——
                        // 用户看到的是「卡死」。回 -32601 至少让它立刻走错误分支。
                        tracing::warn!(
                            target: "sincearc::acp", id, %method,
                            "unimplemented client method -> -32601"
                        );
                        let _ = proc_for_task
                            .respond(
                                id,
                                Err(serde_json::json!({
                                    "code": -32601,
                                    "message": format!("method not found: {method}"),
                                })),
                            )
                            .await;
                        continue;
                    }
                    // 只有登记过的 id 才允许被回答（见 agent_respond_request）
                    pending.mark(&profile_for_task, id).await;
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
                proc: proc.clone(),
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
        capabilities: outcome.capabilities,
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
/// 把某个已存的 ACP 会话 load 进**当前已连接**的 agent 进程。
///
/// 为什么需要它：群成员各自锚在一个 acp_session_id 上，向它发 prompt 前，这个会话必须在
/// 那个进程里是「活着」的 —— 否则 agent 只会回 not_found。而且这一步要幂等：
/// 界面可能在多个成员之间来回切，不能每次换人都把进程重起一遍。
#[tauri::command]
pub async fn session_load(
    state: State<'_, AppState>,
    profile_id: String,
    acp_session_id: String,
    cwd: String,
) -> Result<Option<acp::SessionModes>, CmdError> {
    if acp_session_id.trim().is_empty() {
        return Err(CmdError::new(50602, "session id 不能为空"));
    }
    let handle = state
        .get(&profile_id)
        .await
        .ok_or_else(|| CmdError::new(50400, "这条连接还没建立 —— 先连接它，再向成员发消息"))?;
    let params = serde_json::json!({
        "sessionId": acp_session_id,
        "cwd": cwd,
        "mcpServers": [],
    });
    let v = handle
        .proc
        .request("session/load", params, Duration::from_secs(120))
        .await
        .map_err(|e| CmdError::new(50402, format!("session/load 失败：{e}")))?;
    let modes = acp::modes_from_response(&v);
    if let Some(m) = &modes {
        state.set_modes(acp_session_id.clone(), m.clone()).await;
    }
    state
        .insert_session(
            acp_session_id.clone(),
            SessionRecord {
                profile_id: profile_id.clone(),
                cwd,
            },
        )
        .await;
    tracing::info!(
        target: "sincearc::ipc", profile = %profile_id, session = %acp_session_id,
        "member session loaded"
    );
    Ok(modes)
}

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

/// 回答 agent 发来的请求。目前只有 `session/request_permission`。
///
/// `outcome` 原样透传 ACP 的 RequestPermissionOutcome：
/// `{"outcome":"selected","optionId":"..."}` 或 `{"outcome":"cancelled"}`。
/// 取消语义只属于「用户中止这一轮」；超时自拒要选 reject_* 选项，不能回 cancelled。
#[tauri::command]
pub async fn agent_respond_request(
    state: State<'_, AppState>,
    profile_id: String,
    id: u64,
    outcome: serde_json::Value,
) -> Result<(), CmdError> {
    // 先摘登记再写回：同一个请求被点两次（双击、两个窗口）时，第二次必须被挡住，
    // 否则我们会往一个 agent 已经处理完的 id 上再写一条响应。
    if !state.pending.take(&profile_id, id).await {
        return Err(CmdError::new(50500, "这个请求已失效或已被回答"));
    }
    let handle = state
        .get(&profile_id)
        .await
        .ok_or_else(|| CmdError::new(50501, "连接已断开，无法回答这个请求"))?;
    match handle
        .proc
        .respond(id, Ok(serde_json::json!({ "outcome": outcome })))
        .await
    {
        Ok(()) => {
            tracing::info!(
                target: "sincearc::ipc", profile = %profile_id, id,
                "permission answered"
            );
            Ok(())
        }
        Err(e) => {
            // 写不进去就把登记还回去：用户可能想再点一次，别让请求凭空消失。
            state.pending.mark(&profile_id, id).await;
            tracing::warn!(
                target: "sincearc::ipc", profile = %profile_id, id, error = %e,
                "respond failed"
            );
            Err(CmdError::new(50502, format!("写回决定失败：{e}")))
        }
    }
}

#[tauri::command]
pub async fn agent_disconnect(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<(), CmdError> {
    // 会话跟着进程一起死：先摘记录，别让 prompt 打到已关闭的进程上
    let dead = state.drop_sessions_of(&profile_id).await;
    // 进程没了，挂在它上面的权限请求也答不了了，登记表一并清掉
    state.pending.clear(&profile_id).await;
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

#[cfg(test)]
mod launch_input_tests {
    use super::{validate_launch_input, ProfileDto};

    fn dto(program: &str, cwd: &str) -> ProfileDto {
        ProfileDto {
            id: "p".into(),
            name: "p".into(),
            launch: "wsl".into(),
            program: program.into(),
            args: vec!["acp".into()],
            cwd: cwd.into(),
            default_mode: None,
            distro: Some("fedora".into()),
            shell: Some("zsh".into()),
            ssh_host: None,
            ssh_port: None,
            ssh_user: None,
            ssh_auth: None,
            ssh_key_path: None,
            ssh_password: None,
        }
    }

    #[test]
    fn empty_cwd_is_rejected_with_its_own_code() {
        // 空 cwd 以前会掉进 50200，只报「agent closed stdout」，和命令写错无法区分
        let err = validate_launch_input(&dto("hermes", "  ")).expect_err("空 cwd 必须被拦");
        assert_eq!(err.code, 50201);
        assert!(err.msg.contains("工作目录"));
    }

    #[test]
    fn empty_program_is_rejected() {
        let err = validate_launch_input(&dto("  ", "/home/jerry")).expect_err("空命令必须被拦");
        assert_eq!(err.code, 50202);
    }

    #[test]
    fn normal_input_passes() {
        assert!(validate_launch_input(&dto("hermes", "/home/jerry")).is_ok());
    }
}
