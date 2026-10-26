//! Tauri command 层：薄适配 —— 只做 DTO 转换与错误映射，不写业务逻辑。
//!
//! 错误统一走 `CmdError { code, msg }`：前端据 code 分支，msg 给人看。
//! 码位约定（sincearc 自己的小表，与 ACP 无关）：
//!   50100 尚未实现 / 50101 环境不满足（找不到程序等）
//!   50200 agent 启动或握手失败
//!   50300 状态不一致（未连接就调用等）

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::Manager;
use tauri::State;

use crate::acp::launch::{render_command_line, AgentProfile, Launch, SshAuth, SshSpec};
use crate::acp::{self, transport};
use crate::db;
use crate::lock::SessionLockDto;
use crate::mcp::{self, McpCatalogEntryDto, McpServerDto, SessionMcpStateDto};
use crate::state::{
    AgentHandle, AppState, Captured, ContextMode, ContextReason, DelegateEntry, DelegateStatus,
    Delegates, ReplayCapture, SessionRecord,
};
use crate::wire::{Meta, WireEvent};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

const STEER_INVALID: u32 = 50001;
/// 插话回执的认领窗口：响应之后再等这么久，等那条「无 messageId」的 chunk 到。
const STEER_RECLAIM_WINDOW: Duration = Duration::from_secs(2);
const STEER_NO_COMMAND: u32 = 50404;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AsideEvent {
    session_id: String,
    ui_session_id: Option<String>,
    text: String,
}

/// 权限应答的本地轨迹元数据（不进 ACP 协议）。
///
/// 收成一个结构体而不是继续往命令上加参数：参数已经到 10 个，clippy 的 too_many_arguments 是
/// 真信号 —— 这些字段本来就是一件事（这次决定是什么、谁做的、写了什么备注）。
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PermissionDecisionMeta {
    /// allow / reject；缺省按 reject 记（不许猜成放行过）
    pub verdict: Option<String>,
    pub option_id: Option<String>,
    pub option_label: Option<String>,
    /// 动作发起成员（不是按下去的人）
    pub actor_member_id: Option<String>,
    pub note: Option<String>,
    /// user / auto:edits
    pub via: Option<String>,
}

/// 已知的 ACP toolCall.kind。界面把它们归成五类文案（delete/move、read/search 各自合并），
/// 但策略表仍按原始 kind 精确匹配。
fn is_known_permission_kind(kind: &str) -> bool {
    matches!(kind, "edit" | "delete" | "move" | "execute" | "read" | "search")
}

#[derive(Debug, Clone, PartialEq)]
struct AllowOption {
    id: String,
    label: Option<String>,
}

/// 只从请求自带的 options 里挑 allow_once / allow_always；挑不到就不自动答。
fn pick_allow_option(params: &serde_json::Value) -> Option<AllowOption> {
    params
        .get("options")
        .and_then(serde_json::Value::as_array)?
        .iter()
        .find_map(|option| {
            let option = option.as_object()?;
            let kind = option.get("kind").and_then(serde_json::Value::as_str)?;
            if !matches!(kind, "allow_once" | "allow_always") {
                return None;
            }
            let id = normalize_optional(
                option
                    .get("optionId")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
            )?;
            let label = normalize_optional(
                option
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
            );
            Some(AllowOption { id, label })
        })
}

fn turn_policy_decision(option: &AllowOption, actor_member_id: Option<String>) -> PermissionDecisionMeta {
    PermissionDecisionMeta {
        verdict: Some("allow".into()),
        option_id: Some(option.id.clone()),
        option_label: option.label.clone(),
        actor_member_id,
        note: Some("本轮同类自动允许".into()),
        via: Some("turn-policy".into()),
    }
}

struct PermissionTrace<'a> {
    verdict: &'a str,
    option_id: Option<&'a str>,
    option_label: Option<&'a str>,
    actor_member_id: Option<&'a str>,
    via: &'a str,
    note: Option<&'a str>,
}

fn permission_decision_payload(id: u64, turn_id: &str, trace: PermissionTrace<'_>) -> serde_json::Value {
    serde_json::json!({
        "requestId": id,
        "verdict": trace.verdict,
        "optionId": trace.option_id,
        "optionLabel": trace.option_label,
        "actorMemberId": trace.actor_member_id,
        "via": trace.via,
        "note": trace.note,
        "turnId": turn_id,
    })
}

/// `agent_respond_request` 与自动应答共用的写回逻辑。
///
/// 调用方负责先从 `PendingRequests` 摘登记；这里只做「写回 + 恢复轮状态 + 写轨迹」。
/// 写回失败时返回 50502，由调用方决定是否把登记还回去。
struct PermissionReply {
    turn_id: Option<String>,
    decision: PermissionDecisionMeta,
}

/// 命令参数里的空串/纯空白按缺失处理：轨迹里要写 null，不写 ""。
fn normalize_optional(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

/// 推给界面的事件。UI 只认这个枚举，不直接看 ACP 的 JSON ——
/// 协议类型收敛在 acp 模块里（见 acp/mod.rs 的约束 1）。
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub enum AcpEvent {
    /// 单向通知，例如 `session/update`
    Notification {
        method: String,
        #[ts(type = "unknown")]
        params: serde_json::Value,
        /// 事件所属的 ACP 会话（agent 没给就是 None）
        #[ts(optional = nullable)]
        session_id: Option<String>,
        /// 该投给哪个界面会话 —— 由后端按会话归属填，前端不许猜
        #[ts(optional = nullable)]
        ui_session_id: Option<String>,
        /// 发言者（群成员身份）；主 agent 时为 None
        #[ts(optional = nullable)]
        author_id: Option<String>,
    },
    /// agent 发来的请求，需要回响应（S4 起接线）
    Request {
        #[ts(type = "number")]
        id: u64,
        method: String,
        #[ts(type = "unknown")]
        params: serde_json::Value,
        #[ts(optional = nullable)]
        session_id: Option<String>,
        #[ts(optional = nullable)]
        ui_session_id: Option<String>,
        #[ts(optional = nullable)]
        author_id: Option<String>,
    },
    /// 连接建立后的自检：前端收到它就说明事件通道是通的
    Hello,
    /// agent 进程的输出流关闭了
    Exited,
    /// 一轮 prompt 开始了（UI 用来进入生成态；此时还没有任何 chunk）
    PromptStarted {
        session_id: String,
        /// 这一轮的 id（后端生成，前端只认它）。派活子会话取父轮；没有父轮时为 None。
        #[ts(optional = nullable)]
        turn_id: Option<String>,
        #[ts(optional = nullable)]
        ui_session_id: Option<String>,
        #[ts(optional = nullable)]
        author_id: Option<String>,
    },
    /// 一轮 prompt 正常结束（带 stopReason 等原始结果）
    PromptResult {
        session_id: String,
        #[ts(optional = nullable)]
        ui_session_id: Option<String>,
        #[ts(optional = nullable)]
        author_id: Option<String>,
        #[ts(type = "unknown")]
        result: serde_json::Value,
    },
    /// 一轮 prompt 失败（超时、进程没了、agent 报错）
    PromptFailed {
        session_id: String,
        #[ts(optional = nullable)]
        ui_session_id: Option<String>,
        #[ts(optional = nullable)]
        author_id: Option<String>,
        msg: String,
    },
}

/// 一次 ACP `usage_update` 的可显示结果。
///
/// `percent` 在后端算好：前端只负责排版，不再做除法，也不按消息长度猜。
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct UsageDto {
    pub ui_session_id: Option<String>,
    /// 谁的报告（群聊里每个成员各有上下文）
    pub author_id: Option<String>,
    /// 已用
    #[ts(type = "number")]
    pub used: u64,
    /// 窗口大小
    #[ts(type = "number")]
    pub size: u64,
    /// 0–100 的整数百分比，后端算好（前端不做除法）
    pub percent: u8,
}

impl UsageDto {
    fn from_raw(
        ui_session_id: Option<String>,
        author_id: Option<String>,
        used: u64,
        size: u64,
    ) -> Self {
        Self {
            ui_session_id,
            author_id,
            used,
            size,
            percent: usage_percent(used, size),
        }
    }
}
/// agent 通过 `session/update.availableCommands` 报上来的一项命令。
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct CommandDto {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hint: Option<String>,
}

impl CommandDto {
    fn from_value(value: &serde_json::Value) -> Option<Self> {
        let name = value.get("name").and_then(serde_json::Value::as_str)?;
        if name.trim().is_empty() {
            return None;
        }
        Some(Self {
            name: name.to_string(),
            description: value
                .get("description")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
            hint: value
                .get("hint")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
        })
    }
}

fn commands_from_payload(payload: &serde_json::Value) -> Vec<CommandDto> {
    payload
        .get("commands")
        .and_then(serde_json::Value::as_array)
        .map(|items| items.iter().filter_map(CommandDto::from_value).collect())
        .unwrap_or_default()
}

/// 整数百分比。`used > 0` 时至少给 1%，避免「明明用了一点却显示 0%」。
fn usage_percent(used: u64, size: u64) -> u8 {
    if size == 0 {
        return 0;
    }
    let raw = ((used as u128 * 100) / size as u128).min(100);
    if used > 0 && raw == 0 {
        1
    } else {
        raw as u8
    }
}

#[derive(Debug, Serialize)]
pub struct CmdError {
    pub code: u32,
    pub msg: String,
}

impl CmdError {
    pub(crate) fn new(code: u32, msg: impl Into<String>) -> Self {
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

/// 外链打开只放行这三类 scheme。
///
/// 前端已经把这些 scheme 之外的东西降级成纯文本了，这里是**第二道闸**：
/// 渲染层哪天被改坏，也不至于让 `file:` / `javascript:` 之类的串走到命令行。
/// 另外拒绝含控制字符的 URL —— 换行 / 制表符进命令行会被截断或续成第二条命令。
pub fn is_openable_url(url: &str) -> bool {
    let trimmed = url.trim();
    if trimmed.is_empty() || trimmed.chars().any(|c| c.is_control()) {
        return false;
    }
    let Some((scheme, rest)) = trimmed.split_once(':') else {
        return false;
    };
    if rest.trim().is_empty() {
        return false;
    }
    matches!(
        scheme.to_ascii_lowercase().as_str(),
        "http" | "https" | "mailto"
    )
}

/// 在系统默认浏览器里打开外链。
///
/// 起进程是 fire-and-forget：拿不到「浏览器真的开了」这个事实，所以成功时前端不提示，
/// 只有这里返回错误时前端才说「打不开」。
#[tauri::command]
pub async fn open_external(url: String) -> Result<(), CmdError> {
    if !is_openable_url(&url) {
        return Err(CmdError::new(50102, "只允许打开 http / https / mailto 链接"));
    }
    let target = url.trim().to_string();

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // `start` 的第一个引号参数是**窗口标题**：必须先给一对空引号，再单独引住 URL，
        // 否则 URL 里的 `&` 会被 cmd 当成命令分隔符（`?a=1&b=2` 会被切成两条命令）。
        std::process::Command::new(crate::acp::launch::system_tool("cmd.exe"))
            .args(["/C", "start", "", &target])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| CmdError::new(50705, format!("打不开系统浏览器：{e}")))?;
    }

    #[cfg(not(windows))]
    {
        let opener = if cfg!(target_os = "macos") {
            "open"
        } else {
            "xdg-open"
        };
        std::process::Command::new(opener)
            .arg(&target)
            .spawn()
            .map_err(|e| CmdError::new(50705, format!("打不开系统浏览器：{e}")))?;
    }

    Ok(())
}

/// 前端传来的 profile。字段与 `AgentProfile` 不同 —— 那是内部结构，
/// 这里只接 UI 真正会填的那几项。
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
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
    /// 这个连接默认注入的 MCP 名单；None = 继承目录全部。
    /// 新插入时按这个值（None 时看 `mcp_inherit_default`）落库；更新已有行时不碰它。
    #[serde(default)]
    pub default_mcp: Option<Vec<String>>,
    /// 上次握手报上来的能力快照；从未握手为 None。
    #[serde(default)]
    pub caps: Option<acp::AgentCaps>,
    #[serde(default)]
    #[ts(type = "number | null")]
    pub caps_at: Option<i64>,
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

pub const CONTEXT_MESSAGES_MAX: u32 = 20;

pub fn is_valid_theme(theme: &str) -> bool {
    matches!(theme, "dark" | "light" | "system")
}

/// 代码配色主题 id 的**唯一来源**；前端 `src/lib/highlight/themes.ts` 必须与它一致（有测试守）。
pub const CODE_THEME_IDS: [&str; 5] = ["github-dark", "one-dark", "dracula", "nord", "sincearc"];

pub const DEFAULT_CODE_THEME: &str = CODE_THEME_IDS[0];

pub fn is_valid_code_theme(theme: &str) -> bool {
    CODE_THEME_IDS.contains(&theme)
}

/// 未知/空 id 一律回落默认；写库与读库都走这里。
pub fn normalize_code_theme(theme: &str) -> &'static str {
    CODE_THEME_IDS
        .iter()
        .copied()
        .find(|id| *id == theme)
        .unwrap_or(DEFAULT_CODE_THEME)
}

/// 自动同意的默认档（新会话的初始态）。`off` = 不替用户答；`edits` = 编辑类自动答。
pub fn is_valid_auto_approve(level: &str) -> bool {
    matches!(level, "off" | "edits")
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct AppSettingsDto {
    pub context_messages: u32,
    pub theme: String,
    /// 新会话默认自动同意档：off | edits
    pub auto_approve_default: String,
    /// 新建连接时是否默认继承整份 MCP 目录；只影响新连接，不追溯已有连接。
    #[serde(default = "default_true")]
    pub mcp_inherit_default: bool,
    /// 流式回答按到达节奏平滑推进；只影响渲染层。
    #[serde(default = "default_true")]
    pub tween_enabled: bool,
    /// markdown 代码块配色 id；未知值读回时回落 github-dark。
    #[serde(default = "default_code_theme")]
    pub code_theme: String,
}

fn default_true() -> bool {
    true
}

fn default_code_theme() -> String {
    DEFAULT_CODE_THEME.into()
}

impl Default for AppSettingsDto {
    fn default() -> Self {
        Self {
            context_messages: 5,
            theme: "dark".into(),
            auto_approve_default: "off".into(),
            mcp_inherit_default: true,
            tween_enabled: true,
            code_theme: DEFAULT_CODE_THEME.into(),
        }
    }
}

/// `settings_load` 的返回：设置本身 + 读不出来的脏值说明。
///
/// 脏值不阻塞启动，但必须让人看见（诊断面板）并留日志 —— 静默用默认值等于骗人。
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct SettingsReport {
    pub settings: AppSettingsDto,
    pub issues: Vec<String>,
}

impl AppSettingsDto {
    fn validate(&self) -> Result<(), CmdError> {
        if self.context_messages > CONTEXT_MESSAGES_MAX {
            return Err(CmdError::new(50001, "附带条数超出范围（0–20）"));
        }
        if !is_valid_theme(&self.theme) {
            return Err(CmdError::new(50001, "未知主题"));
        }
        if !is_valid_auto_approve(&self.auto_approve_default) {
            return Err(CmdError::new(50001, "未知的自动同意档"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct CommandPreview {
    /// 真正会执行的命令行（可粘贴）
    pub line: String,
}

#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct ConnectOutcome {
    pub agent_name: String,
    pub agent_version: String,
    #[ts(type = "number")]
    pub protocol_version: i64,
    pub load_session: bool,
    pub auth_methods: Vec<String>,
    /// 握手报上来的协议能力。
    /// 通用客户端靠它显示「这个 agent 支持什么」，而不是按名字查表。
    pub caps: acp::AgentCaps,
    /// 本次连接落到的会话：复用了旧的就还是旧的，没有就新建。
    /// 前端直接用它，不必再发一次 session/new（那样每连一次就多一个空会话）。
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub session_id: Option<String>,
    pub modes: Option<acp::SessionModes>,
    /// 这次连接是新建、续上，还是有句柄但续不上。
    pub resume: ResumeOutcome,
    /// 续上前本地事件水位；新建会话时为 None。
    /// 不用 ts(optional)：和 ts(type=…) 一起用时 ts-rs 会丢掉类型覆盖，生成出 bigint。
    #[ts(type = "number | null")]
    pub last_event_seq: Option<i64>,
}

/// 一条已存 ACP 会话能否在当前进程里恢复。
///
/// `Unavailable` 是终态：调用方必须显示失败并由用户决定是否新建，
/// 不允许在这里悄悄回退到 `session/new`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub enum ResumeOutcome {
    Resumed {
        acp_session_id: String,
        note: String,
    },
    Unavailable {
        acp_session_id: String,
        reason: String,
    },
    Fresh,
}

#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct SessionLoadOutcome {
    pub resume: ResumeOutcome,
    pub modes: Option<acp::SessionModes>,
    /// 同 SessionConnectOutcome：不用 ts(optional)，否则类型会被生成成 bigint。
    #[ts(type = "number | null")]
    pub last_event_seq: Option<i64>,
}

#[derive(Debug, PartialEq, Eq)]
enum ResumeDecision {
    Fresh,
    CanLoad,
    Unavailable {
        acp_session_id: String,
        reason: String,
    },
}

const RESUME_UNSUPPORTED: &str = "这个 agent 不支持恢复会话（没报 loadSession 能力）";

fn resume_decision(
    handle: Option<&db::ResumeHandle>,
    load_session: bool,
) -> ResumeDecision {
    match handle {
        None => ResumeDecision::Fresh,
        Some(h) if !load_session => ResumeDecision::Unavailable {
            acp_session_id: h.acp_session_id.clone(),
            reason: RESUME_UNSUPPORTED.to_string(),
        },
        Some(_) => ResumeDecision::CanLoad,
    }
}

fn resumed_note(expected_agent: Option<&str>, current_agent: &str) -> String {
    match expected_agent {
        Some(prev) if !prev.is_empty() && prev != current_agent => format!(
            "注意：上次是 {prev}，这次是 {current_agent}，上下文可能不等价"
        ),
        _ => String::new(),
    }
}

fn resumed_outcome(
    acp_session_id: &str,
    expected_agent_name: Option<&str>,
    current_agent_name: &str,
) -> ResumeOutcome {
    ResumeOutcome::Resumed {
        acp_session_id: acp_session_id.to_string(),
        note: resumed_note(expected_agent_name, current_agent_name),
    }
}

fn resume_load_failed(acp_session_id: &str, e: &transport::TransportError) -> ResumeOutcome {
    ResumeOutcome::Unavailable {
        acp_session_id: acp_session_id.to_string(),
        reason: format!("session/load 失败：{e}"),
    }
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

/// 生成能力面板展示的命令行。
///
/// 必须走与真正启动相同的 `command_line()` 包装；`binary` / `argv` 只覆盖
/// 「被执行的程序与参数」，WSL/SSH 的 relay、cwd、PATH 仍由启动层决定。
#[tauri::command]
pub async fn command_preview(
    profile: ProfileDto,
    cwd: Option<String>,
    binary: Option<String>,
    argv: Option<Vec<String>>,
) -> Result<CommandPreview, CmdError> {
    let mut parsed = to_profile(&profile)?;
    if let Some(binary) = binary {
        parsed.program = binary;
    }
    if let Some(argv) = argv {
        parsed.args = argv;
    }

    let cwd = cwd.unwrap_or_else(|| profile.cwd.clone());
    let cwd = if cwd.trim().is_empty() {
        parsed.default_cwd.to_string_lossy().into_owned()
    } else {
        cwd
    };
    let spec = parsed
        .command_line(&cwd)
        .map_err(|e| CmdError::new(50000, format!("生成命令预览失败：{e}")))?;
    let line = render_command_line(&spec);

    // 密码认证会为 SSH_ASKPASS 写临时脚本；预览不需要它，渲染完立刻清掉。
    if let Some(path) = spec.cleanup {
        let _ = std::fs::remove_file(path);
    }
    Ok(CommandPreview { line })
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

/// 记住这次握手报上来的能力。
///
/// 失败只警告：记不住能力是显示层的问题，不能让一条本来已经连上的 agent 断开。
fn remember_profile_caps(db: &db::Db, profile_id: &str, caps: &acp::AgentCaps) {
    let json = match serde_json::to_string(caps) {
        Ok(json) => json,
        Err(e) => {
            tracing::warn!(target: "sincearc::ipc", profile = %profile_id, error = %e, "序列化能力失败");
            return;
        }
    };
    if let Err(e) = db.save_profile_caps(profile_id, &json, db::now()) {
        tracing::warn!(target: "sincearc::ipc", profile = %profile_id, error = %e, "记录能力失败");
    }
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
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct ProbeOutcome {
    pub agent_name: String,
    pub agent_version: String,
    #[ts(type = "number")]
    pub protocol_version: i64,
    pub load_session: bool,
    /// 握手报上来的能力。探测的价值一半在这里：
    /// 用户能**在保存连接之前**知道这个 agent 支不支持恢复会话 / 图片 / fork。
    pub caps: acp::AgentCaps,
}

/* ---------- 群聊成员（docs/group-chat.md） ---------- */

#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
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
    state: State<'_, AppState>,
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
        let _ = proc.kill_tree("disconnect").await;
        return Ok(AgentUserTestOutcome {
            ok: false,
            detail: format!(
                "{} 没报 loadSession 能力，恢复不了已有会话 —— 换个 sessionId 没用，这条连接起不了玩家",
                outcome.agent_name
            ),
        });
    }

    let mcp_servers = match mcp::profile_mcp_servers(state.inner(), &profile.id).await {
        Ok(servers) => servers,
        Err(error) => {
            let _ = proc.kill_tree("disconnect").await;
            return Err(error);
        }
    };
    let params = serde_json::json!({
        "sessionId": acp_session_id,
        "cwd": cwd,
        "mcpServers": mcp_servers,
    });
    let res = proc
        .request("session/load", params, Duration::from_secs(120))
        .await;
    let _ = proc.kill_tree("disconnect").await;

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
    if user.handle.trim().chars().any(|c| c.is_whitespace()) {
        // 解析靠空白断词：短名里有空格就永远 @ 不到（docs/group-chat.md §3）
        return Err(CmdError::new(50602, "短名里不能有空格"));
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

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct MentionResolution {
    /// 命中的成员 id / 连接 id / 会话 id / cwd；没命中时全为 None
    pub member_id: Option<String>,
    pub profile_id: Option<String>,
    pub acp_session_id: Option<String>,
    pub cwd: String,
    pub handle: Option<String>,
    /// 用户敲了 `@xxx` 但没对上成员时给出他敲的内容
    pub token: Option<String>,
}

/// 解析一条群聊消息里的 `@`，并把「成员 → 连接 → ACP 会话 → cwd」一次定死。
///
/// 前端只负责展示返回结果：命中就按这里给的四元组投递；没命中但有 token 就提示；
/// 成员不可用时由这里给出明确错误码，不再让前端各自猜。
#[tauri::command]
pub async fn mention_resolve(
    state: State<'_, AppState>,
    session_id: String,
    text: String,
) -> Result<MentionResolution, CmdError> {
    let members = state
        .db
        .session_members(&session_id)
        .map_err(|e| CmdError::new(50000, format!("读群成员失败：{e}")))?;
    let handles: Vec<String> = members.iter().map(|m| m.handle.clone()).collect();

    let Some(hit) = crate::mention::find(&text, &handles) else {
        return Ok(MentionResolution {
            member_id: None,
            profile_id: None,
            acp_session_id: None,
            cwd: String::new(),
            handle: None,
            token: crate::mention::token(&text),
        });
    };

    let matched: Vec<_> = members
        .iter()
        .filter(|m| crate::mention::same_handle(&m.handle, &hit.handle))
        .collect();
    if matched.len() != 1 {
        return Err(CmdError::new(
            50601,
            format!("短名 @{} 对应了多个成员，数据不一致 —— 请到成员设置里修正", hit.handle),
        ));
    }
    let member = matched[0];

    if member.acp_session_id.trim().is_empty() {
        return Err(CmdError::new(
            50602,
            "这个成员还没有可用的会话 —— 到成员设置里点「测试」建一个",
        ));
    }

    let cwd = state
        .db
        .load_profiles()
        .map_err(|e| CmdError::new(50000, format!("读取配置失败：{e}")))?
        .into_iter()
        .find(|p| p.id == member.profile_id)
        .map(|p| p.cwd)
        .ok_or_else(|| CmdError::new(50601, "成员所属的连接不存在，数据不一致"))?;

    Ok(MentionResolution {
        member_id: Some(member.id.clone()),
        profile_id: Some(member.profile_id.clone()),
        acp_session_id: Some(member.acp_session_id.clone()),
        cwd,
        handle: Some(member.handle.clone()),
        token: None,
    })
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
    let _ = proc.kill_tree("disconnect").await;
    // 探测只回报结果，**不写库**：它测的可能是还没保存的草稿（或者改了一半的命令），
    // 把这份能力记到已保存的 profile 上，面板就会显示一个这条连接从未有过的结论。
    // 记能力只发生在真正连上的那一刻（agent_connect）。
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
        caps: outcome.caps,
    })
}

/// 前端启动时订阅**唯一**的事件通道（`docs/ipc-contract.md` §3）。
///
/// 反复调用是安全的：后来的订阅者替换旧的 sink（例如窗口重载）。
/// 之前是「每次 agent_connect 带一条 Channel」，连 N 个 agent 就要订阅 N 次，
/// 事件也可能因为某条通道关闭而整体失联。
/// 收轮失败不该让这一轮的结果丢掉：轨迹缺个结束时间，比整轮报错轻得多。
fn end_turn_safely(db: &Arc<db::Db>, turn_id: &str, status: &str, stop_reason: Option<&str>) {
    if let Err(e) = db.end_turn(turn_id, status, stop_reason) {
        tracing::warn!(target: "sincearc::trace", error = %e, "收轮失败");
    }
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// 失败轮的 `stop_reason`：错误码 + 一行摘要，最多 200 字。
///
/// `TransportError::Agent` 带的是 JSON-RPC 错误对象，优先用里面的 code；
/// 其余传输层错误用稳定的小写标识，至少能区分「超时」「进程关了」「写不进去」。
fn prompt_failure_reason(e: &transport::TransportError) -> String {
    let code = match e {
        transport::TransportError::Agent(v) => v
            .get("code")
            .map(|c| c.to_string())
            .unwrap_or_else(|| "agent".to_string()),
        transport::TransportError::Timeout(_) => "timeout".to_string(),
        transport::TransportError::Closed => "closed".to_string(),
        transport::TransportError::Io(_) => "io".to_string(),
        transport::TransportError::Json(_) => "json".to_string(),
        transport::TransportError::Spawn { .. } => "spawn".to_string(),
        transport::TransportError::Launch(_) => "launch".to_string(),
        transport::TransportError::Handshake { .. } => "handshake".to_string(),
    };
    let summary = e.to_string().replace('\n', " ");
    truncate_chars(&format!("{code}: {summary}"), 200)
}

/// prompt 正常返回时的终态。用户点过停止、或 agent 自己回了 `cancelled`，
/// 统一收成 finished + stop_reason='cancelled'；其余情况保留 agent 的原始 stopReason。
fn prompt_success_outcome(
    cancelled_by_user: bool,
    stop_reason: Option<String>,
) -> (&'static str, Option<String>) {
    if cancelled_by_user || stop_reason.as_deref() == Some("cancelled") {
        ("finished", Some("cancelled".to_string()))
    } else {
        ("finished", stop_reason)
    }
}

/// 派活终态。取消优先于 agent 自己报的 stopReason：用户已经明确要求停止时，
/// agent 随后回 `end_turn` 或中途报错都不该把这次派活说成正常完成 / 真失败。
fn delegate_end_status(cancelled_by_user: bool, fallback: DelegateStatus) -> DelegateStatus {
    if cancelled_by_user {
        DelegateStatus::Cancelled
    } else {
        fallback
    }
}

/// prompt 返回 Err 时的终态：用户点过停止是 finished + cancelled，否则是 failed + 可解释原因。
fn prompt_failure_outcome(
    cancelled_by_user: bool,
    e: &transport::TransportError,
) -> (&'static str, Option<String>) {
    if cancelled_by_user {
        ("finished", Some("cancelled".to_string()))
    } else {
        ("failed", Some(prompt_failure_reason(e)))
    }
}

/// 容量提示阈值（docs/message-model.md §13.2）：只用于判断是否提示，不参与任何删除。
pub const STORAGE_HINT_MAX_EVENTS: i64 = 50_000;
pub const STORAGE_HINT_MAX_DAYS: i64 = 90;

#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct StorageStatsDto {
    #[ts(type = "number")]
    pub atom_count: i64,
    #[ts(type = "number")]
    pub chat_count: i64,
    #[ts(type = "number")]
    pub trace_count: i64,
    #[ts(type = "number")]
    pub bytes: i64,
    #[ts(type = "number | null")]
    pub oldest_at: Option<i64>,
    #[ts(type = "number")]
    pub threshold_count: i64,
    #[ts(type = "number")]
    pub threshold_days: i64,
    pub over: bool,
    pub reasons: Vec<String>,
}

#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct TraceBackfillDto {
    #[ts(type = "number")]
    pub captured: i64,
    #[ts(type = "number")]
    pub added: i64,
    #[ts(type = "number")]
    pub skipped: i64,
    pub timed_out: bool,
}

/// 只给标记，文案由前端按原因映射。顺序固定：先条数、后年龄。
pub(crate) fn storage_hint_reasons(
    stats: &db::StorageStatsSnapshot,
    now_ms: i64,
) -> Vec<String> {
    let mut reasons = Vec::new();
    if stats.trace_count > STORAGE_HINT_MAX_EVENTS {
        reasons.push("count".to_string());
    }
    let oldest_cutoff = now_ms - STORAGE_HINT_MAX_DAYS * 24 * 3600 * 1000;
    if stats.oldest_at.is_some_and(|at| at < oldest_cutoff) {
        reasons.push("age".to_string());
    }
    reasons
}

/// 读一个会话的存储统计。只读 atoms：不写表、不改行，也不删除任何数据。
#[tauri::command]
pub async fn session_storage_stats(
    state: State<'_, AppState>,
    ui_session_id: String,
) -> Result<StorageStatsDto, CmdError> {
    let stats = state
        .db
        .storage_stats(&ui_session_id)
        .map_err(|e| CmdError::new(50000, format!("读取存储统计失败：{e}")))?;
    let reasons = storage_hint_reasons(&stats, crate::trace::now_ms());
    Ok(StorageStatsDto {
        atom_count: stats.atom_count,
        chat_count: stats.chat_count,
        trace_count: stats.trace_count,
        bytes: stats.bytes,
        oldest_at: stats.oldest_at,
        threshold_count: STORAGE_HINT_MAX_EVENTS,
        threshold_days: STORAGE_HINT_MAX_DAYS,
        over: !reasons.is_empty(),
        reasons,
    })
}

#[tauri::command]
pub async fn session_trace(
    state: State<'_, AppState>,
    session_id: String,
    limit: Option<i64>,
) -> Result<Vec<crate::trace::TraceTurn>, CmdError> {
    let limit = limit.unwrap_or(50).clamp(1, 200);
    let turns = state
        .db
        .load_turns(&session_id, limit)
        .map_err(|e| CmdError::new(50000, format!("读取轮次失败：{e}")))?;
    // 事件按轮取：先取这一批轮次的所有事件（seq 倒序），聚合时再按轮分组
    let events = state
        .db
        .load_events(&session_id, limit * 200)
        .map_err(|e| CmdError::new(50000, format!("读取轨迹失败：{e}")))?;
    let turns = crate::trace::with_orphan_turns(turns, &session_id, &events);
    // 轮次上的 prompt 字段保留给老数据作历史兼容；正文权威在 atoms（chat / text.user）。
    Ok(crate::trace::aggregate(turns, events))
}

const REPLAY_LOAD_TIMEOUT: Duration = Duration::from_secs(120);
const REPLAY_SETTLE_DELAY: Duration = Duration::from_secs(2);

/// 捕获窗口的 RAII 守卫：命令里任何提前 return（含 `?`）都会在 drop 时关窗。
/// 不关窗的后果是所有后续 live 轨迹继续被吞进内存，而不是只影响一次补录。
struct ReplayWindow {
    capture: Arc<ReplayCapture>,
    acp_sid: String,
    closed: bool,
}

impl ReplayWindow {
    fn open(capture: Arc<ReplayCapture>, acp_sid: String) -> Self {
        capture.open(&acp_sid);
        Self {
            capture,
            acp_sid,
            closed: false,
        }
    }

    fn close(&mut self) -> Vec<Captured> {
        if self.closed {
            return Vec::new();
        }
        self.closed = true;
        self.capture.close(&self.acp_sid)
    }
}

impl Drop for ReplayWindow {
    fn drop(&mut self) {
        if !self.closed {
            self.capture.close(&self.acp_sid);
        }
    }
}

/// FNV-1a 64 位，输出 `rp-` + 16 位小写十六进制。
/// 输入里的 payload 用捕获时保存的规范化字符串，不重新序列化 JSON。
fn replay_batch_hash(ui_session_id: &str, items: &[crate::state::Captured]) -> String {
    // FNV-1a 64：只求确定性，不求抗碰撞。输入是「整批事件的有序 (kind, payload) 序列」。
    // 刻意**不含 at**：ACP 的 session/update 不带时间戳，at 只能取捕获时刻，
    // 同一段重放两次会得到不同值 —— 真机上实测过第二遍多写 14 行（§13.1.2 记录了这次修正）。
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut eat = |bytes: &[u8]| {
        for byte in bytes {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    };
    eat(ui_session_id.as_bytes());
    for item in items {
        eat(b"\x1f");
        eat(item.kind.as_bytes());
        eat(b"\x1f");
        eat(item.payload_json.as_bytes());
    }
    format!("{hash:016x}")
}

fn replay_atom_id(batch: &str, index: usize) -> String {
    format!("rp-{batch}-{index}")
}

/// 显式补录：打开捕获窗口，`session/load` 触发 agent 重放轨迹，收尾后落成
/// `source='replay'` 原子。只写 trace 通道，不动正文；不自动触发。
#[tauri::command]
pub async fn session_trace_backfill(
    state: State<'_, AppState>,
    profile_id: String,
    acp_session_id: String,
    ui_session_id: String,
    cwd: String,
) -> Result<TraceBackfillDto, CmdError> {
    let handle = state.get(&profile_id).await.ok_or_else(|| {
        CmdError::new(50300, "目标连接已断开，补录需要在连接态下进行")
    })?;

    let mut window = ReplayWindow::open(state.replay.clone(), acp_session_id.clone());
    let mcp_servers =
        mcp::target_mcp_servers(state.inner(), &profile_id, Some(&ui_session_id)).await?;
    let params = serde_json::json!({
        "sessionId": acp_session_id,
        "cwd": cwd,
        "mcpServers": mcp_servers,
    });
    let load_and_settle = async {
        handle
            .proc
            .request("session/load", params, REPLAY_LOAD_TIMEOUT)
            .await?;
        tokio::time::sleep(REPLAY_SETTLE_DELAY).await;
        Ok::<(), transport::TransportError>(())
    };
    let timed_out = match tokio::time::timeout(REPLAY_LOAD_TIMEOUT, load_and_settle).await {
        Ok(Ok(())) => false,
        // request 自身的超时与整体硬上限同值，谁先触发都按「超时收尾」处理，
        // 保留已经捕获的部分；明确的 agent/IO 错误才是失败。
        Ok(Err(transport::TransportError::Timeout(_))) => true,
        Ok(Err(e)) => {
            window.close();
            return Err(CmdError::new(
                50200,
                format!("session/load 失败：{e}"),
            ));
        }
        Err(_) => true,
    };
    let captured = window.close();
    if captured.is_empty() {
        return Ok(TraceBackfillDto {
            captured: 0,
            added: 0,
            skipped: 0,
            timed_out: false,
        });
    }

    let captured_count = captured.len() as i64;
    let batch = replay_batch_hash(&ui_session_id, &captured);
    let turn_id = format!("turn-replay-{ui_session_id}-{batch}");
    // 批次是幂等单位：同一段重放两次，batch 相同 → 轮已存在 → 整批跳过，一条都不再写。
    let already = state
        .db
        .replay_turn_exists(&ui_session_id, &turn_id)
        .map_err(|e| CmdError::new(50000, format!("查询补录轮失败：{e}")))?;
    if already {
        return Ok(TraceBackfillDto {
            captured: captured_count,
            added: 0,
            skipped: captured_count,
            timed_out,
        });
    }
    let min_at = captured
        .iter()
        .map(|item| item.at)
        .min()
        .unwrap_or_default();
    let max_at = captured
        .iter()
        .map(|item| item.at)
        .max()
        .unwrap_or_default();
    state
        .db
        .insert_replay_turn(&ui_session_id, &turn_id, min_at, max_at)
        .map_err(|e| CmdError::new(50000, format!("记录补录轮失败：{e}")))?;
    let atoms: Vec<db::ReplayAtom> = captured
        .into_iter()
        .enumerate()
        .map(|(index, item)| db::ReplayAtom {
            id: replay_atom_id(&batch, index),
            at: item.at,
            kind: item.kind,
            payload_json: item.payload_json,
            refs: item.refs,
            ext: item.ext,
            truncated: item.truncated,
        })
        .collect();
    let (added, skipped) = state
        .db
        .append_replay_atoms(&ui_session_id, &turn_id, &atoms)
        .map_err(|e| CmdError::new(50000, format!("写入补录轨迹失败：{e}")))?;
    Ok(TraceBackfillDto {
        captured: captured_count,
        added,
        skipped,
        timed_out,
    })
}

#[tauri::command]
pub async fn ipc_subscribe(
    state: State<'_, AppState>,
    channel: Channel<WireEvent>,
) -> Result<(), CmdError> {
    state.bus.subscribe(channel);
    tracing::info!(target: "sincearc::ipc", "webview subscribed to event bus");
    // 告诉前端「通道是通的」：这条收不到，问题在通道本身而不是 ACP 事件。
    state.bus.emit_json(
        "conn.ready",
        true,
        Meta::default(),
        &serde_json::json!({ "droppedBefore": state.bus.dropped() }),
    );
    Ok(())
}

/// 把合批好的一段正文发出去。形状与单条 chunk 完全一致 ——
/// 前端不需要知道「这条是合并过的」，它只会收到更少的 IPC 事件。
fn emit_text(
    flush: Option<crate::coalesce::Flush>,
    bus: &Arc<crate::wire::EventBus>,
    profile_id: &str,
) {
    let Some(f) = flush else { return };
    let mut update = serde_json::json!({
        "sessionUpdate": "agent_message_chunk",
        "content": { "type": "text", "text": f.text },
    });
    // 正文的 messageId 原样带给前端：插话回执没有这个字段，前端就是靠它把两者分开的。
    if let Some(message_id) = f.message_id {
        update["messageId"] = serde_json::Value::String(message_id);
    }
    let params = serde_json::json!({
        "sessionId": f.session_id,
        "update": update,
    });
    let event = AcpEvent::Notification {
        method: "session/update".to_string(),
        params,
        session_id: f.session_id,
        ui_session_id: f.ui_session_id,
        author_id: f.author_id,
    };
    bus.emit_json(
        "acp.notification",
        true,
        Meta {
            profile_id: Some(profile_id.to_string()),
            session_id: event_session(&event),
            ui_session_id: event_ui(&event),
            author_id: event_author(&event),
        },
        &event,
    );
}

fn event_session(e: &AcpEvent) -> Option<String> {
    match e {
        AcpEvent::Notification { session_id, .. } => session_id.clone(),
        _ => None,
    }
}
fn event_ui(e: &AcpEvent) -> Option<String> {
    match e {
        AcpEvent::Notification { ui_session_id, .. } => ui_session_id.clone(),
        _ => None,
    }
}
fn event_author(e: &AcpEvent) -> Option<String> {
    match e {
        AcpEvent::Notification { author_id, .. } => author_id.clone(),
        _ => None,
    }
}

/// 把一条 ACP 消息落成轨迹事件（思考 / 工具调用 / 权限 / 模式 / 用量）。
///
/// 三个「不落」的条件都是有意的：
/// 1. 不是轨迹类消息（`agent_message_chunk` 是对话正文，走 messages）；
/// 2. 当前没有活动轮次且不在补录捕获窗口 —— 那是没人认领的重放，不是这一轮的历史；
/// 3. 没有界面会话归属 —— 落下去就是孤儿行，谁也没法看。
///
/// 补录窗口打开时，事件先收进 `ReplayCapture` 并直接返回：不写 live、不当孤儿。
/// 命令列表不走这里：它只进内存并按 ACP 会话 id 覆盖，不属于任何一轮轨迹。
async fn record_trace(
    db: &Arc<db::Db>,
    routes: &crate::state::Routes,
    turns: &crate::state::Turns,
    replay: &Arc<crate::state::ReplayCapture>,
    method: &str,
    params: &serde_json::Value,
) {
    let Some(mut captured) = crate::trace::parse(method, params) else {
        return;
    };
    let Some(acp_sid) = params.get("sessionId").and_then(serde_json::Value::as_str) else {
        return;
    };
    // 捕获窗口优先：session/load 的重放没有活动轮次，先收进内存而不是当孤儿丢掉。
    // 这里挪到归属检查之前：窗口只按 ACP 会话 id 辨认，捕获结果由补录命令统一落库。
    let mut payload_json = captured.payload.to_string();
    if replay.is_open(acp_sid) {
        let item = crate::state::Captured {
            at: crate::trace::now_ms(),
            kind: captured.kind.to_string(),
            payload_json: payload_json.clone(),
            refs: captured.refs,
            ext: captured.ext,
            truncated: captured.truncated,
        };
        if replay.push(acp_sid, item) {
            return;
        }
        // 检查窗口与写入之间刚被关闭：重新解析，继续按 live 走。
        let Some(fresh) = crate::trace::parse(method, params) else {
            return;
        };
        captured = fresh;
        payload_json = captured.payload.to_string();
    }
    let Some(record) = routes.get(acp_sid).await else {
        return;
    };
    let Some(ui_sid) = record.ui_session_id.clone() else {
        return;
    };
    let Some(turn_id) = turns.current(acp_sid).await else {
        return;
    };
    let input = db::EventInput {
        turn_id,
        author_id: record.author_id.clone(),
        kind: captured.kind.to_string(),
        payload_json,
        refs: captured.refs,
        ext: captured.ext,
        schema: None,
        source: "live".to_string(),
        truncated: captured.truncated,
    };
    if let Err(e) = db.append_events(&ui_sid, &[input]) {
        // 轨迹落库失败不能影响这一轮对话，但必须留痕（否则就是「轨迹莫名少一段」）
        tracing::warn!(target: "sincearc::trace", error = %e, "轨迹落库失败");
    }
}

/// 把 kill_tree 的结论送到诊断面板；只有降级才额外触发一次性通知条。
fn report_process_cleanup(
    state: &AppState,
    profile_id: &str,
    ui_session_id: Option<&str>,
    why: &str,
    agent_id: &str,
    outcome: &transport::KillOutcome,
) {
    let message = format!("proc {agent_id} {why} -> {}", outcome.describe());
    let topic = if outcome.may_leave_residue() {
        "proc.warning"
    } else {
        "proc.diag"
    };
    let payload = serde_json::json!({
        "message": message,
        "why": why,
        "agentId": agent_id,
        "uiSessionId": ui_session_id,
    });
    let delivered = state.bus.emit_json(
        topic,
        true,
        Meta {
            profile_id: Some(profile_id.to_string()),
            ui_session_id: ui_session_id.map(str::to_string),
            ..Default::default()
        },
        &payload,
    );
    if !delivered {
        tracing::debug!(
            target: "sincearc::proc", profile = %profile_id,
            "diagnostics event not delivered (webview not subscribed)"
        );
    }
}

/// 摘掉一个 profile 的所有运行期状态并回收进程树。
///
/// 取消一轮会真的结束 agent：下一轮由前端重新连接（会话句柄仍在库里，可 resume）。
/// 断开连接同理。返回 None 表示这个 profile 本来就没连接。
async fn teardown_profile(
    state: &AppState,
    profile_id: &str,
    why: &str,
) -> Option<transport::KillOutcome> {
    let ui_sessions = state.ui_sessions_of(profile_id).await;
    let handle = state.take(profile_id).await;
    let outcome = if let Some(handle) = &handle {
        let outcome = handle.proc.kill_tree(why).await;
        report_process_cleanup(
            state,
            profile_id,
            ui_sessions.first().map(String::as_str),
            why,
            handle.proc.agent_id(),
            &outcome,
        );
        Some(outcome)
    } else {
        None
    };

    let dead = state.drop_sessions_of(profile_id).await;
    for session_id in &dead {
        state.take_cancel(session_id).await;
        state.turns.end(session_id).await;
        state.turn_approvals.clear_session(session_id).await;
    }
    for session_id in state.routes.acp_session_ids_of(profile_id).await {
        state.turn_approvals.clear_session(&session_id).await;
    }
    state.pending.clear(profile_id).await;
    tracing::info!(
        target: "sincearc::ipc",
        profile = %profile_id,
        why,
        sessions = dead.len(),
        process = handle.is_some(),
        clean = ?outcome.as_ref().map(|o| o.clean),
        "profile torn down"
    );
    outcome
}

#[tauri::command]
pub async fn agent_connect(
    state: State<'_, AppState>,
    profile: ProfileDto,
    // 这次连接是给哪个界面会话用的（没有就不建映射）
    ui_session_id: Option<String>,
) -> Result<ConnectOutcome, CmdError> {
    let id = profile.id.clone();
    validate_launch_input(&profile)?;
    let parsed = to_profile(&profile)?;

    // 重连语义：先摘掉旧的（幂等），再起新的。不静默复用旧进程 ——
    // 用户点「连接」就是想要一个新会话。
    let _ = teardown_profile(state.inner(), &id, "replace").await;

    let cwd = profile.cwd.clone();
    let (proc, mut incoming, outcome) = acp::initialize(&parsed, &cwd, HANDSHAKE_TIMEOUT)
        .await
        .map_err(|e| {
            tracing::warn!(target: "sincearc::ipc", profile = %id, error = %e, "handshake failed");
            launch_error(&profile, e)
        })?;

    // 能力跟着握手落库：重启或未连接时面板仍能说清「上次连上时它支持什么」。
    remember_profile_caps(&state.db, &id, &outcome.caps);

    // 入站消息逐条推给界面。走全局总线：连接不再各自持有一条 Channel。
    let bus = state.bus.clone();
    // 转发 task 里拿不到 State，所以把进程句柄和「待回答登记表」clone 进去：
    // 未实现的方法要在这里当场拒答，权限请求要在这里登记 id。
    let proc = Arc::new(proc);
    let proc_for_task = proc.clone();
    let pending = state.pending.clone();
    let profile_for_task = id.clone();
    // 归属表：事件该投给哪个界面会话，完全由后端记录决定（前端不再猜「当前会话」）
    let routes = state.routes.clone();
    // delegate 正文缓冲：子会话的 chunk 要在落轨迹之前进入 registry，终态才能取摘要。
    let delegates = state.delegates.clone();
    // 命令是 ACP 会话的运行时属性：按会话 id 覆盖，不落库、不依赖界面会话归属。
    let commands_for_task = state.commands.clone();
    // 插话只要让事件泵知道「这条文本是不是回执」，不参与轮次/归属判断。
    let asides_for_task = state.asides.clone();
    // 轨迹采集：事件落地需要库和「这一轮是谁」——两者都在 task 外面，clone 进去
    let db_for_trace = state.db.clone();
    let turns_for_trace = state.turns.clone();
    let replay_for_trace = state.replay.clone();
    let turn_approvals_for_task = state.turn_approvals.clone();
    let locks = state.locks.clone();
    tokio::spawn(async move {
        /// 从 ACP 原始消息里取 sessionId，再按归属表补上界面会话与作者
        async fn route(
            routes: &crate::state::Routes,
            params: &serde_json::Value,
        ) -> (Option<String>, Option<String>, Option<String>) {
            let acp = params
                .get("sessionId")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
            match acp {
                Some(sid) => match routes.get(&sid).await {
                    Some(rec) => (Some(sid), rec.ui_session_id, rec.author_id),
                    None => (Some(sid), None, None),
                },
                None => (None, None, None),
            }
        }

        // 正文合批（docs/ipc-contract.md §4）：chunk 是逐段来的，一条一个事件会让
        // webview 每秒处理几百次 IPC + 几百次 React 更新。在这里按 30ms / 4KB 合并，
        // 前端就只管渲染（以前是前端自己攒 40ms，等于让 UI 线程承担流控）。
        let mut text = crate::coalesce::TextCoalescer::default();
        let mut ticker = tokio::time::interval(std::time::Duration::from_millis(30));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            let msg = tokio::select! {
                maybe = incoming.recv() => match maybe {
                    Some(m) => m,
                    None => break,
                },
                // 没有新消息时把攒着的正文发出去：否则一段说完就停住，界面像卡了
                _ = ticker.tick() => {
                    emit_text(text.flush(), &bus, &profile_for_task);
                    continue;
                }
            };

            // 正文以外的任何事件都先把缓冲冲掉，保证顺序（工具调用不能跑到它前面的文字之前）
            let is_text = matches!(
                &msg,
                transport::Incoming::Notification { method, params }
                    if method == "session/update"
                        && params
                            .get("update")
                            .and_then(|u| u.get("sessionUpdate"))
                            .and_then(serde_json::Value::as_str)
                            == Some("agent_message_chunk")
            );
            if !is_text {
                emit_text(text.flush(), &bus, &profile_for_task);
            }

            // 先冲正文缓冲、再落轨迹、再 emit。这里只记录 delegate 子会话的正文；
            // 父会话自己的正文仍走原来的合批路径。
            if is_text {
                if let transport::Incoming::Notification { params, .. } = &msg {
                    if let (Some(child_sid), Some(chunk)) = (
                        params
                            .get("sessionId")
                            .and_then(serde_json::Value::as_str),
                        params
                            .get("update")
                            .and_then(|update| update.get("content"))
                            .and_then(|content| content.get("text"))
                            .and_then(serde_json::Value::as_str),
                    ) {
                        if let Some(handle_id) = delegates.by_child_acp(child_sid).await {
                            delegates.append_text(&handle_id, chunk).await;
                        }
                    }
                }
            }

            let payload = match msg {
                transport::Incoming::Notification { method, params } => {
                    tracing::debug!(target: "sincearc::acp", %method, "notification");
                    let commands_captured = crate::trace::parse(&method, &params)
                        .filter(|captured| captured.kind == "commands");
                    if commands_captured.is_none() {
                        record_trace(
                            &db_for_trace,
                            &routes,
                            &turns_for_trace,
                            &replay_for_trace,
                            &method,
                            &params,
                        )
                        .await;
                    }
                    let (session_id, ui_session_id, author_id) = route(&routes, &params).await;
                    // usage 是计量而不是轨迹动作：照样落 session_events（供重启后恢复），
                    // 同时单独推一条可丢的 acp.usage，下一帧会补上。
                    if let Some((used, size)) = crate::trace::parse(&method, &params)
                        .filter(|captured| captured.kind == "usage")
                        .and_then(|captured| crate::trace::usage_of(&captured.payload))
                    {
                        let dto = UsageDto::from_raw(
                            ui_session_id.clone(),
                            author_id.clone(),
                            used,
                            size,
                        );
                        let usage_meta = Meta {
                            profile_id: Some(profile_for_task.clone()),
                            session_id: session_id.clone(),
                            ui_session_id: ui_session_id.clone(),
                            author_id: author_id.clone(),
                        };
                        bus.emit_json("acp.usage", false, usage_meta, &dto);
                    }
                    // 命令列表只存在内存里，键是 ACP 会话 id；到得再早也不影响归属。
                    // 连接退出时不清理，断开重连会覆盖；session/new / session/load 会再推。
                    if let Some(captured) = commands_captured {
                        if let Some(acp_sid) = session_id.as_deref() {
                            let commands = commands_from_payload(&captured.payload);
                            let count = commands.len();
                            commands_for_task
                                .put_commands(acp_sid, commands.clone())
                                .await;
                            let payload = serde_json::json!({
                                "acpSessionId": acp_sid,
                                "commands": commands,
                            });
                            let meta = Meta {
                                profile_id: Some(profile_for_task.clone()),
                                session_id: Some(acp_sid.to_string()),
                                ..Default::default()
                            };
                            bus.emit_json("acp.commands", false, meta, &payload);
                            tracing::debug!(
                                target: "sincearc::trace", profile = %profile_for_task,
                                acp_session = %acp_sid, count, "commands updated in memory"
                            );
                        } else {
                            tracing::debug!(
                                target: "sincearc::trace", profile = %profile_for_task,
                                "commands dropped: notification has no acp session id"
                            );
                        }
                    }
                    // 只认「我们自己发起的一轮」里的写操作：`session/load` 会把上一轮
                    // 的 tool_call 重放一遍，那不是正在写，不能把提示条点亮。
                    let in_active_turn = match session_id.as_deref() {
                        Some(acp_sid) => turns_for_trace.current(acp_sid).await.is_some(),
                        None => false,
                    };
                    if let (Some(acp_sid), true) = (session_id.as_deref(), in_active_turn) {
                        // author 属于会话归属，不在 ACP 的 update 里；补进锁解析参数，
                        // 让群聊里显示「谁在写」而不是只有主 agent。
                        let mut lock_params = params.clone();
                        if let (Some(author), Some(object)) =
                            (author_id.as_deref(), lock_params.as_object_mut())
                        {
                            object.insert(
                                "authorId".to_string(),
                                serde_json::Value::String(author.to_string()),
                            );
                        }
                        if let Some(lock_state) = locks.update(acp_sid, &lock_params) {
                            let dto =
                                SessionLockDto::from_state(&lock_state, acp_sid.to_string(), ui_session_id.clone());
                            let lock_meta = Meta::for_session(
                                profile_for_task.clone(),
                                acp_sid.to_string(),
                                ui_session_id.clone(),
                                author_id.clone(),
                            );
                            bus.emit_json("session.lock", false, lock_meta, &dto);
                        }
                    }
                    if is_text {
                        // 攒起来；够 4KB 就先发一段（长回答开头不必等满 30ms）
                        let message_id = params
                            .get("update")
                            .and_then(|u| crate::trace::refs_of(u).get("messageId").cloned());
                        let chunk = params
                            .get("update")
                            .and_then(|u| u.get("content"))
                            .and_then(|c| c.get("text"))
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        if let Some(acp_sid) = session_id.as_deref() {
                            if message_id.is_none() {
                                if let Some(aside_ui) = asides_for_task.pending_ui(acp_sid).await {
                                    // 回执与正文不能混在同一个合批里：先冲正文，再单独发 aside。
                                    emit_text(text.flush(), &bus, &profile_for_task);
                                    if !chunk.is_empty() {
                                        let aside = AsideEvent {
                                            session_id: acp_sid.to_string(),
                                            ui_session_id: aside_ui.or(ui_session_id.clone()),
                                            text: chunk,
                                        };
                                        bus.emit_json(
                                            "acp.aside",
                                            true,
                                            Meta::for_session(
                                                profile_for_task.clone(),
                                                acp_sid.to_string(),
                                                aside.ui_session_id.clone(),
                                                author_id.clone(),
                                            ),
                                            &aside,
                                        );
                                    }
                                    // 认领即结算：否则窗口内后续的无 id chunk 也会被当成回执。
                                    asides_for_task.settle(acp_sid).await;
                                    continue;
                                }
                            }
                        }
                        emit_text(
                            text.push(
                                session_id.clone(),
                                ui_session_id.clone(),
                                author_id.clone(),
                                message_id,
                                &chunk,
                            ),
                            &bus,
                            &profile_for_task,
                        );
                        continue;
                    }
                    AcpEvent::Notification {
                        method,
                        params,
                        session_id,
                        ui_session_id,
                        author_id,
                    }
                }
                transport::Incoming::Request { id, method, params } => {
                    tracing::debug!(target: "sincearc::acp", id, %method, "agent request");
                    if method == "fs/read_text_file" {
                        let acp_session_id = params
                            .get("sessionId")
                            .and_then(serde_json::Value::as_str);
                        let result = match acp_session_id {
                            Some(session_id) => match routes.get(session_id).await {
                                Some(record) => {
                                    let cwd = PathBuf::from(record.cwd);
                                    acp::fs::handle_read_request(&params, &cwd)
                                }
                                None => Err(serde_json::json!({
                                    "code": -32602,
                                    "message": "未知会话",
                                })),
                            },
                            // 没有 sessionId 就连 cwd 都定位不到；交给纯函数统一报「缺少参数」。
                            None => acp::fs::handle_read_request(&params, std::path::Path::new("")),
                        };
                        match &result {
                            Ok(_) => tracing::info!(
                                target: "sincearc::acp", id,
                                "fs/read_text_file ok"
                            ),
                            Err(e) => tracing::warn!(
                                target: "sincearc::acp", id,
                                error = %e,
                                "fs/read_text_file rejected"
                            ),
                        }
                        if let Err(e) = proc_for_task.respond(id, result).await {
                            tracing::warn!(
                                target: "sincearc::acp", id, error = %e,
                                "fs/read_text_file response failed"
                            );
                        }
                        continue;
                    }
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
                    // 权限请求本身也是轨迹的一部分（用户要能事后查到「当时授权了什么」；
                    // 聊天正文里已不再写「权限决定」这类系统消息）
                    // JSON-RPC 的请求 id 不在 params 里；先补进去，trace::parse 才能把它
                    // 落成 refs.requestId（和之后的 permission_decision 对上同一块）。
                    let mut trace_params = params.clone();
                    if let Some(object) = trace_params.as_object_mut() {
                        object.insert(
                            "requestId".to_string(),
                            serde_json::Value::String(id.to_string()),
                        );
                    }
                    record_trace(
                        &db_for_trace,
                        &routes,
                        &turns_for_trace,
                        &replay_for_trace,
                        &method,
                        &trace_params,
                    )
                    .await;
                    // 权限请求意味着这一轮在等用户。只有当前确实有活动轮时才改状态：
                    // 两轮之间收到的权限请求不能凭空造出一轮，也不能落到别的轮上。
                    let waiting_turn = match params
                        .get("sessionId")
                        .and_then(serde_json::Value::as_str)
                    {
                        Some(acp_sid) => turns_for_trace.current(acp_sid).await,
                        None => None,
                    };
                    if let Some(turn_id) = waiting_turn.as_deref() {
                        if let Err(e) = db_for_trace.mark_turn_waiting_approval(turn_id) {
                            tracing::warn!(
                                target: "sincearc::trace", error = %e, turn = %turn_id,
                                "权限等待状态落库失败"
                            );
                        }
                    }
                    // 只有登记过的 id 才允许被回答（见 agent_respond_request）
                    pending
                        .mark_with_turn(&profile_for_task, id, waiting_turn.clone())
                        .await;
                    let (session_id, ui_session_id, mut author_id) =
                        route(&routes, &params).await;
                    // 归属表通常已带作者；万一没有，再用这一轮的 author_id 补。
                    // 仍然拿不到就保持 None —— 不许拿会话成员列表里的第一个人顶替。
                    if author_id.is_none() {
                        if let Some(turn_id) = waiting_turn.as_deref() {
                            author_id = db_for_trace
                                .turn_context(turn_id)
                                .ok()
                                .flatten()
                                .and_then(|(_, author)| author);
                        }
                    }
                    let request_kind = params
                        .get("toolCall")
                        .and_then(|tool| tool.get("kind"))
                        .and_then(serde_json::Value::as_str);
                    if let (Some(acp_sid), Some(turn_id), Some(_ui_sid), Some(kind)) = (
                        session_id.as_deref(),
                        waiting_turn.as_deref(),
                        ui_session_id.as_deref(),
                        request_kind,
                    ) {
                        if is_known_permission_kind(kind)
                            && turn_approvals_for_task
                                .covers(acp_sid, turn_id, kind)
                                .await
                        {
                            match pick_allow_option(&params) {
                                Some(allow) => {
                                    // 先摘登记再写回：自动路径也必须一条请求只答一次。
                                    let (known, pending_turn) =
                                        pending.take_with_turn(&profile_for_task, id).await;
                                    if !known {
                                        tracing::warn!(
                                            target: "sincearc::acp", id, acp_session = %acp_sid,
                                            turn = %turn_id, %kind,
                                            "turn-policy matched but request was no longer pending; falling back to dialog"
                                        );
                                    } else {
                                        let reply = PermissionReply {
                                            turn_id: Some(turn_id.to_string()),
                                            decision: turn_policy_decision(&allow, author_id.clone()),
                                        };
                                        match respond_permission(
                                            &db_for_trace,
                                            &profile_for_task,
                                            &proc_for_task,
                                            id,
                                            serde_json::json!({
                                                "outcome": "selected",
                                                "optionId": allow.id,
                                            }),
                                            reply,
                                        )
                                        .await
                                        {
                                            Ok(()) => {
                                                tracing::info!(
                                                    target: "sincearc::acp", id, acp_session = %acp_sid,
                                                    turn = %turn_id, %kind,
                                                    "permission auto-answered by turn policy"
                                                );
                                                continue;
                                            }
                                            Err(e) => {
                                                // 写不进去就把登记还回去，让用户能在弹窗里重试。
                                                pending
                                                    .mark_with_turn(&profile_for_task, id, pending_turn)
                                                    .await;
                                                tracing::warn!(
                                                    target: "sincearc::acp", id, acp_session = %acp_sid,
                                                    turn = %turn_id, %kind, error = %e.msg,
                                                    "turn-policy respond failed; falling back to dialog"
                                                );
                                            }
                                        }
                                    }
                                }
                                None => tracing::warn!(
                                    target: "sincearc::acp", id, acp_session = %acp_sid,
                                    turn = %turn_id, %kind,
                                    "turn-policy matched but request has no allow option; falling back to dialog"
                                ),
                            }
                        }
                    }
                    AcpEvent::Request {
                        id,
                        method,
                        params,
                        session_id,
                        ui_session_id,
                        author_id,
                    }
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
            // 终态事件一律无损：丢了就等于「回答消失」。
            let (topic, lossless) = match &payload {
                AcpEvent::Notification { .. } => ("acp.notification", true),
                AcpEvent::Request { .. } => ("acp.request", true),
                AcpEvent::Hello => ("conn.hello", true),
                AcpEvent::Exited => ("conn.exited", true),
                AcpEvent::PromptStarted { .. } => ("acp.prompt.started", true),
                AcpEvent::PromptResult { .. } => ("acp.prompt.result", true),
                AcpEvent::PromptFailed { .. } => ("acp.prompt.failed", true),
            };
            // notification/request 的 sessionId 可能缺失；prompt* 事件一定有。
            // 两种情况都要归一成 Option，否则 or-pattern 类型对不上。
            let (sid, ui, author) = match &payload {
                AcpEvent::Notification { session_id, ui_session_id, author_id, .. }
                | AcpEvent::Request { session_id, ui_session_id, author_id, .. } => (
                    session_id.clone(),
                    ui_session_id.clone(),
                    author_id.clone(),
                ),
                AcpEvent::PromptStarted { session_id, ui_session_id, author_id, .. }
                | AcpEvent::PromptResult { session_id, ui_session_id, author_id, .. }
                | AcpEvent::PromptFailed { session_id, ui_session_id, author_id, .. } => (
                    Some(session_id.clone()),
                    ui_session_id.clone(),
                    author_id.clone(),
                ),
                AcpEvent::Hello | AcpEvent::Exited => (None, None, None),
            };
            let meta = Meta {
                profile_id: Some(profile_for_task.clone()),
                session_id: sid,
                ui_session_id: ui,
                author_id: author,
            };
            bus.emit_json(topic, lossless, meta, &payload);
        }
        emit_text(text.flush(), &bus, &profile_for_task);
        // 连接已经没了：这条连接名下所有 ACP 会话的本轮策略一并作废。
        for acp_sid in routes.acp_session_ids_of(&profile_for_task).await {
            turn_approvals_for_task.clear_session(&acp_sid).await;
        }
        bus.emit_json(
            "conn.exited",
            true,
            Meta {
                profile_id: Some(profile_for_task.clone()),
                ..Default::default()
            },
            &AcpEvent::Exited,
        );
        // 输出流结束不等于整棵树结束：主进程可能先退出，而 cargo / tsc / node
        // 这类子孙还挂在同一进程组里。这里再走一次同侧回收；若调用方已经
        // kill 过，kill_tree 的幂等分支会立即返回。
        let _ = proc_for_task.kill_tree("exit").await;
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
            }),
        )
        .await;

    // 会话归属：优先复用上次的（agent 侧因此不会每连一次就多一个空会话）
    let handle = state.get(&id).await.expect("just inserted");
    let (session_id, modes, resume, last_event_seq) =
        attach_session(&state, &id, &handle, &cwd, ui_session_id.clone()).await;

    // 自检：这条如果前端也没收到，问题在 Channel 本身而不是 ACP 事件
    tracing::info!(target: "sincearc::ipc", "hello -> webview");
    if !state.bus.emit_json(
        "conn.hello",
        true,
        Meta { profile_id: Some(id.clone()), ..Default::default() },
        &AcpEvent::Hello,
    ) {
        tracing::warn!(target: "sincearc::ipc", "hello 未送达：前端还没订阅事件通道");
    }

    Ok(ConnectOutcome {
        agent_name: outcome.agent_name,
        agent_version: outcome.agent_version,
        protocol_version: outcome.protocol_version,
        load_session: outcome.load_session,
        auth_methods: outcome.auth_methods,
        caps: outcome.caps,
        session_id,
        modes,
        resume,
        last_event_seq,
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
    ui_session_id: Option<String>,
) -> (Option<String>, Option<acp::SessionModes>, ResumeOutcome, Option<i64>) {
    let resume_handle = match ui_session_id.as_deref() {
        Some(ui_sid) => state.db.live_handle(ui_sid).unwrap_or_else(|e| {
            tracing::warn!(target: "sincearc::ipc", error = %e, session = %ui_sid, "读取恢复句柄失败");
            None
        }),
        // 设置页手动连接没有界面会话：这里只是连通性验证，不做恢复。
        // 恢复是"打开会话"的动作。此处若拿 last_acp_session 去 load，在不支持 loadSession 的
        // agent 上会直接变成 Unavailable，让用户误以为"连接失败"（旧实现在这里是静默回退到 session/new，
        // 那正是 E13.7 要消灭的静默降级）。所以显式声明为"没有句柄"。
        None => None,
    };
    let watermark = resume_handle.as_ref().and_then(|h| h.last_event_seq);

    match resume_decision(resume_handle.as_ref(), handle.outcome.load_session) {
        ResumeDecision::Unavailable {
            acp_session_id,
            reason,
        } => {
            tracing::warn!(
                target: "sincearc::ipc", session = %acp_session_id, reason = %reason,
                "resume unavailable; refusing to create a fresh session"
            );
            return (
                None,
                None,
                ResumeOutcome::Unavailable {
                    acp_session_id,
                    reason,
                },
                watermark,
            );
        }
        ResumeDecision::CanLoad => {
            let h = resume_handle.expect("CanLoad implies a handle");
            let mcp_servers = match mcp::target_mcp_servers(
                state,
                profile_id,
                ui_session_id.as_deref(),
            )
            .await
            {
                Ok(servers) => servers,
                Err(error) => {
                    tracing::warn!(
                        target: "sincearc::ipc", error = %error.msg,
                        "MCP 清单解析失败，拒绝恢复会话"
                    );
                    return (
                        None,
                        None,
                        ResumeOutcome::Unavailable {
                            acp_session_id: h.acp_session_id.clone(),
                            reason: error.msg,
                        },
                        watermark,
                    );
                }
            };
            let req = ResumeRequest {
                profile_id,
                acp_session_id: &h.acp_session_id,
                cwd,
                ui_session_id: ui_session_id.as_deref(),
                expected_agent_name: h.agent_name.as_deref(),
                bind_ui_handle: true,
                mcp_servers: &mcp_servers,
            };
            let (outcome, modes) = load_resume_handle(state, handle, &req).await;
            let session_id = match &outcome {
                ResumeOutcome::Resumed { acp_session_id, .. } => Some(acp_session_id.clone()),
                _ => None,
            };
            return (session_id, modes, outcome, watermark);
        }
        ResumeDecision::Fresh => {}
    }

    let mcp_servers =
        match mcp::target_mcp_servers(state, profile_id, ui_session_id.as_deref()).await {
            Ok(servers) => servers,
            Err(error) => {
                tracing::warn!(
                    target: "sincearc::ipc", error = %error.msg,
                    "MCP 清单解析失败，拒绝新建会话"
                );
                return (
                    None,
                    None,
                    ResumeOutcome::Unavailable {
                        acp_session_id: String::new(),
                        reason: error.msg,
                    },
                    None,
                );
            }
        };

    let created = handle
        .proc
        .request(
            "session/new",
            serde_json::json!({ "cwd": cwd, "mcpServers": mcp_servers }),
            Duration::from_secs(120),
        )
        .await;

    match created {
        Ok(v) => {
            // ACP 规定 session/new 必须回 sessionId；没回就是协议不符。
            // 这里不能 `?`（本函数已改成返回四元组、不是 Result），也不能假装成功：
            // 显式走 Unavailable，让界面把原因写出来、由用户决定重试。
            let Some(sid) = v["sessionId"].as_str().map(str::to_string) else {
                tracing::warn!(target: "sincearc::ipc", "session/new 没有返回 sessionId");
                return (
                    None,
                    None,
                    ResumeOutcome::Unavailable {
                        acp_session_id: String::new(),
                        reason: "agent 返回的 session/new 没有 sessionId（协议不符）".to_string(),
                    },
                    None,
                );
            };
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
                        ui_session_id: ui_session_id.clone(),
                        author_id: None,
                    },
                )
                .await;
            if let Some(ui_sid) = ui_session_id.as_deref() {
                if let Err(e) = state.db.bind_acp_session_with_agent(
                    ui_sid,
                    &sid,
                    cwd,
                    "created",
                    Some(&handle.outcome.agent_name),
                ) {
                    tracing::warn!(target: "sincearc::ipc", error = %e, "记录新会话绑定失败");
                }
            }
            (Some(sid), modes, ResumeOutcome::Fresh, None)
        }
        Err(e) => {
            tracing::warn!(target: "sincearc::ipc", error = %e, "session/new failed");
            (None, None, ResumeOutcome::Fresh, None)
        }
    }
}

/// 统一恢复入口：能力检查、session/load、失败归类、等价性提示都在这里。
/// 调用方拿到 `Unavailable` 后必须显式处理，不能自行改走新建。
struct ResumeRequest<'a> {
    profile_id: &'a str,
    acp_session_id: &'a str,
    cwd: &'a str,
    /// 这次恢复的事件投递目标；成员会话也带群 id。
    ui_session_id: Option<&'a str>,
    expected_agent_name: Option<&'a str>,
    /// 是否把这次 load 写回 ui 会话的 live 句柄。
    /// 成员 load 必须为 false：它带的是群 id，重绑会把群的句柄换成成员的。
    bind_ui_handle: bool,
    /// 调用方已经按「会话级优先、否则连接级」解析好的注入清单。
    mcp_servers: &'a [serde_json::Value],
}

async fn load_resume_handle(
    state: &AppState,
    handle: &AgentHandle,
    req: &ResumeRequest<'_>,
) -> (ResumeOutcome, Option<acp::SessionModes>) {
    let acp_session_id = req.acp_session_id;
    let cwd = req.cwd;
    let ui_session_id = req.ui_session_id;
    let params = serde_json::json!({
        "sessionId": acp_session_id,
        "cwd": cwd,
        "mcpServers": req.mcp_servers,
    });
    let v = match handle
        .proc
        .request("session/load", params, Duration::from_secs(120))
        .await
    {
        Ok(v) => v,
        Err(e) => {
            // 明确拒绝才算会话失效；超时/断管是环境问题，交给重连处理。
            if req.bind_ui_handle && matches!(e, transport::TransportError::Agent(_)) {
                if let Some(ui_id) = ui_session_id {
                    if let Err(db_err) = state.db.mark_acp_invalid(ui_id) {
                        tracing::warn!(target: "sincearc::ipc", error = %db_err, "标记会话失效失败");
                    }
                }
            }
            return (resume_load_failed(acp_session_id, &e), None);
        }
    };

    let modes = acp::modes_from_response(&v);
    if let Some(m) = &modes {
        state
            .set_modes(acp_session_id.to_string(), m.clone())
            .await;
    }
    let author_id = state
        .db
        .agent_user_by_acp_session(acp_session_id)
        .ok()
        .flatten()
        .map(|u| u.id);

    // 成员 load 也带群会话 id（事件要投递回群），但那份 live 句柄属于群主会话：
    // 在这里重绑会把「打开这个群时该恢复哪个 ACP 会话」悄悄换成某个成员的。
    if req.bind_ui_handle {
        if let Some(ui_id) = ui_session_id {
            if let Err(e) = state.db.bind_acp_session_with_agent(
                ui_id,
                acp_session_id,
                cwd,
                "loaded",
                Some(&handle.outcome.agent_name),
            ) {
                tracing::warn!(target: "sincearc::ipc", error = %e, "记录恢复绑定失败");
            }
        }
    }

    state
        .insert_session(
            acp_session_id.to_string(),
            SessionRecord {
                profile_id: req.profile_id.to_string(),
                cwd: cwd.to_string(),
                ui_session_id: ui_session_id.map(str::to_string),
                author_id,
            },
        )
        .await;
    tracing::info!(
        target: "sincearc::ipc", profile = %req.profile_id, session = %acp_session_id,
        "session resumed"
    );
    (
        resumed_outcome(
            acp_session_id,
            req.expected_agent_name,
            &handle.outcome.agent_name,
        ),
        modes,
    )
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

#[tauri::command]
pub async fn mcp_catalog(
    state: State<'_, AppState>,
) -> Result<Vec<McpCatalogEntryDto>, CmdError> {
    let rows = state
        .db
        .mcp_catalog_rows()
        .map_err(|e| CmdError::new(50000, format!("读取 MCP 目录失败：{e}")))?;
    Ok(mcp::catalog_entries(&rows))
}

#[tauri::command]
pub async fn mcp_upsert(
    state: State<'_, AppState>,
    server: McpServerDto,
) -> Result<(), CmdError> {
    mcp::upsert_server(state.inner(), server)
}

#[tauri::command]
pub async fn mcp_delete(state: State<'_, AppState>, name: String) -> Result<(), CmdError> {
    mcp::delete_server(state.inner(), &name)
}

#[tauri::command]
pub async fn session_set_mcp_names(
    state: State<'_, AppState>,
    ui_session_id: String,
    names: Option<Vec<String>>,
) -> Result<(), CmdError> {
    let raw = match names.as_ref() {
        Some(names) => Some(
            serde_json::to_string(names)
                .map_err(|e| CmdError::new(50700, format!("MCP 名单序列化失败：{e}")))?,
        ),
        None => None,
    };
    state
        .db
        .set_session_mcp_names(&ui_session_id, raw.as_deref())
        .map_err(|e| CmdError::new(50000, format!("保存会话 MCP 名单失败：{e}")))
}

#[tauri::command]
pub async fn profile_set_default_mcp(
    state: State<'_, AppState>,
    profile_id: String,
    names: Option<Vec<String>>,
) -> Result<(), CmdError> {
    let raw = match names.as_ref() {
        Some(names) => Some(
            serde_json::to_string(names)
                .map_err(|e| CmdError::new(50700, format!("MCP 名单序列化失败：{e}")))?,
        ),
        None => None,
    };
    state
        .db
        .set_profile_default_mcp(&profile_id, raw.as_deref())
        .map_err(|e| CmdError::new(50000, format!("保存连接 MCP 名单失败：{e}")))
}

#[tauri::command]
pub async fn session_mcp_state(
    state: State<'_, AppState>,
    ui_session_id: String,
) -> Result<SessionMcpStateDto, CmdError> {
    mcp::session_state(state.inner(), &ui_session_id).await
}

#[tauri::command]
pub async fn settings_load(state: State<'_, AppState>) -> Result<SettingsReport, CmdError> {
    let (settings, issues) = state
        .db
        .load_settings_report()
        .map_err(|e| CmdError::new(50000, format!("读取设置失败：{e}")))?;
    Ok(SettingsReport { settings, issues })
}

#[tauri::command]
pub async fn settings_save(
    state: State<'_, AppState>,
    settings: AppSettingsDto,
) -> Result<(), CmdError> {
    settings.validate()?;
    state
        .db
        .save_settings(&settings)
        .map_err(|e| CmdError::new(50000, format!("保存设置失败：{e}")))
}

#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct SessionInfo {
    pub session_id: String,
    /// 建这条会话时 agent 报上来的模式快照。
    /// 发送路径新建的会话也要能显示模式：快照只从「打开/恢复会话」那条路径拿，
    /// 同一条会话从发送路径建出来就会显示「不支持」（docs/data-plane.md §3）。
    pub modes: Option<acp::SessionModes>,
}

/// 新建会话。`cwd` 属于 agent 所在的世界（WSL/SSH 是 `/home/...`）。
#[tauri::command]
pub async fn session_new(
    state: State<'_, AppState>,
    profile_id: String,
    cwd: String,
    // 这个会话是给哪个界面会话用的；设置页为成员建会话时传 None
    ui_session_id: Option<String>,
) -> Result<SessionInfo, CmdError> {
    let handle = state
        .get(&profile_id)
        .await
        .ok_or_else(|| CmdError::new(50300, format!("profile 未连接，不能建会话：{profile_id}")))?;

    let mcp_servers =
        mcp::target_mcp_servers(state.inner(), &profile_id, ui_session_id.as_deref()).await?;
    let result = handle
        .proc
        .request(
            "session/new",
            serde_json::json!({ "cwd": cwd, "mcpServers": mcp_servers }),
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
    let modes = acp::modes_from_response(&result);
    if let Some(found) = &modes {
        state.set_modes(session_id.clone(), found.clone()).await;
    }

    if let Some(ui_id) = ui_session_id.as_deref() {
        state
            .db
            .bind_acp_session_with_agent(
                ui_id,
                &session_id,
                &cwd,
                "created",
                Some(&handle.outcome.agent_name),
            )
            .map_err(|e| CmdError::new(50000, format!("记录会话绑定失败：{e}")))?;
    }

    state
        .insert_session(
            session_id.clone(),
            SessionRecord {
                profile_id: profile_id.clone(),
                cwd,
                ui_session_id,
                author_id: None,
            },
        )
        .await;

    Ok(SessionInfo { session_id, modes })
}

#[tauri::command]
pub async fn session_rebind(
    state: State<'_, AppState>,
    ui_session_id: String,
    profile_id: String,
    cwd: String,
) -> Result<SessionInfo, CmdError> {
    let handle = state.get(&profile_id).await.ok_or_else(|| {
        CmdError::new(50300, format!("profile 未连接，不能重建会话：{profile_id}"))
    })?;

    let mcp_servers = mcp::session_mcp_servers(state.inner(), &ui_session_id).await?;
    let result = handle
        .proc
        .request(
            "session/new",
            serde_json::json!({ "cwd": cwd, "mcpServers": mcp_servers }),
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

    let modes = acp::modes_from_response(&result);
    if let Some(found) = &modes {
        state.set_modes(session_id.clone(), found.clone()).await;
    }

    state
        .db
        .bind_acp_session_with_agent(
            &ui_session_id,
            &session_id,
            &cwd,
            "replaced",
            Some(&handle.outcome.agent_name),
        )
        .map_err(|e| CmdError::new(50000, format!("记录重建绑定失败：{e}")))?;

    tracing::info!(
        target: "sincearc::ipc", profile = %profile_id, session = %session_id,
        ui_session = %ui_session_id, "session rebound"
    );

    state
        .insert_session(
            session_id.clone(),
            SessionRecord {
                profile_id: profile_id.clone(),
                cwd,
                ui_session_id: Some(ui_session_id),
                author_id: None,
            },
        )
        .await;

    Ok(SessionInfo { session_id, modes })
}

/* ---------- delegate / wait（docs/orchestration.md） ---------- */

const DELEGATE_TASK_MAX_BYTES: usize = 8 * 1024;
const DELEGATE_MAX_RUNNING: usize = 3;
const DELEGATE_SUMMARY_CHARS: usize = 200;

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct DelegateHandleDto {
    pub handle_id: String,
    pub child_acp_session_id: String,
    pub target_member_id: String,
    pub target_name: String,
    pub context: ContextMode,
    pub reason: ContextReason,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct DelegateOutcomeDto {
    pub status: String,
    #[ts(optional = nullable)]
    pub summary: Option<String>,
    #[ts(type = "number")]
    pub elapsed_ms: i64,
    #[ts(optional = nullable)]
    pub stop_reason: Option<String>,
}

fn next_delegate_handle_id() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let seq = NEXT.fetch_add(1, Ordering::Relaxed);
    format!("dlg-{}-{seq}", db::now_ms())
}

fn validate_delegate_task_text(task: &str) -> Result<(), CmdError> {
    if task.trim().is_empty() {
        return Err(CmdError::new(50701, "任务正文为空"));
    }
    if task.len() > DELEGATE_TASK_MAX_BYTES {
        return Err(CmdError::new(50701, "任务正文超过 8KB"));
    }
    Ok(())
}

/// 深度按 **ACP 会话**判定：子任务再派活时，它的父会话本身就是某个 handle 的子会话。
/// （原来拿界面会话 id 去比 `child_acp_session_id`，永远为假 —— 那条判据是死的。）
async fn guard_delegate_depth(delegates: &Delegates, parent_acp_session: Option<&str>) -> Result<(), CmdError> {
    if let Some(parent) = parent_acp_session {
        if delegates.is_child(parent).await {
            return Err(CmdError::new(50702, "子任务不能再派活（深度上限 1）"));
        }
    }
    Ok(())
}

async fn guard_delegate_concurrency(
    delegates: &Delegates,
    parent_ui_session_id: &str,
) -> Result<(), CmdError> {
    if delegates
        .count_running_for(parent_ui_session_id)
        .await
        >= DELEGATE_MAX_RUNNING
    {
        return Err(CmdError::new(50703, "同一会话最多同时派 3 个任务"));
    }
    Ok(())
}

/// 纯档位判定：caps 缺失不等于支持；fork 失败与能力缺失必须分开。
fn plan_child(context: Option<bool>, fork_error: bool) -> (ContextMode, ContextReason) {
    match context {
        Some(true) if !fork_error => (ContextMode::MemberFork, ContextReason::Fork),
        Some(true) => (ContextMode::TaskOnly, ContextReason::ForkFailed),
        Some(false) => (ContextMode::TaskOnly, ContextReason::ForkUnsupported),
        None => (ContextMode::TaskOnly, ContextReason::CapsUnknown),
    }
}

/// 成员常驻会话的 fork 判据：绑定 id 去掉首尾空白后仍非空才算有。
fn forkable_member_session(acp_session_id: &str) -> Option<&str> {
    let acp_session_id = acp_session_id.trim();
    (!acp_session_id.is_empty()).then_some(acp_session_id)
}

fn delegate_elapsed_ms(started_at: i64) -> i64 {
    db::now_ms()
        .saturating_sub(started_at.saturating_mul(1000))
        .max(0)
}

fn outcome_from_entry(entry: &DelegateEntry) -> DelegateOutcomeDto {
    DelegateOutcomeDto {
        status: entry.status.as_str().to_string(),
        summary: entry.summary.clone(),
        elapsed_ms: delegate_elapsed_ms(entry.started_at),
        stop_reason: entry.stop_reason.clone(),
    }
}

async fn wait_for_delegate(
    delegates: &Delegates,
    handle_id: &str,
    timeout_ms: u64,
) -> Result<DelegateOutcomeDto, CmdError> {
    let entry = delegates
        .get(handle_id)
        .await
        .ok_or_else(|| CmdError::new(50704, "delegate 句柄不存在"))?;
    if entry.status != DelegateStatus::Running {
        return Ok(outcome_from_entry(&entry));
    }

    // 先注册 waiter 再复查一次状态，避免 finish 恰好发生在 get 与 notified() 之间。
    let notified = entry.done.notified();
    tokio::pin!(notified);
    notified.as_mut().enable();
    if let Some(current) = delegates.get(handle_id).await {
        if current.status != DelegateStatus::Running {
            return Ok(outcome_from_entry(&current));
        }
    }

    match tokio::time::timeout(Duration::from_millis(timeout_ms), notified).await {
        Ok(()) => {
            let current = delegates
                .get(handle_id)
                .await
                .ok_or_else(|| CmdError::new(50704, "delegate 句柄不存在"))?;
            Ok(outcome_from_entry(&current))
        }
        // 超时只说明「还在跑」，不取消、不打扰目标 agent。
        Err(_) => Ok(DelegateOutcomeDto {
            status: "timed_out".to_string(),
            summary: None,
            elapsed_ms: delegate_elapsed_ms(entry.started_at),
            stop_reason: None,
        }),
    }
}

async fn new_child_session(
    handle: &AgentHandle,
    cwd: &str,
    mcp_servers: &[serde_json::Value],
) -> Result<String, CmdError> {
    let result = handle
        .proc
        .request(
            "session/new",
            serde_json::json!({ "cwd": cwd, "mcpServers": mcp_servers }),
            REQUEST_TIMEOUT,
        )
        .await?;
    result
        .get("sessionId")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            CmdError::new(
                50200,
                format!("session/new 没有返回 sessionId，实际返回：{result}"),
            )
        })
}

async fn create_delegate_child(
    handle: &AgentHandle,
    cwd: &str,
    caps_fork: Option<bool>,
    member_acp_session: Option<&str>,
    mcp_servers: &[serde_json::Value],
) -> Result<(String, ContextMode, ContextReason), CmdError> {
    let mut fork_failed = false;
    if plan_child(caps_fork, false).0 == ContextMode::MemberFork {
        let member_acp_session = match member_acp_session {
            Some(acp_session_id) => forkable_member_session(acp_session_id),
            None => None,
        };
        match member_acp_session {
            Some(member_acp_session) => {
                let params = serde_json::json!({
                    "sessionId": member_acp_session,
                    "cwd": cwd,
                    "mcpServers": mcp_servers,
                });
                match handle
                    .proc
                    .request("session/fork", params, REQUEST_TIMEOUT)
                    .await
                {
                    Ok(result) => {
                        let child = result
                            .get("sessionId")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_string)
                            .ok_or_else(|| {
                                CmdError::new(
                                    50200,
                                    format!("session/fork 没有返回 sessionId，实际返回：{result}"),
                                )
                            })?;
                        tracing::info!(
                            target: "sincearc::ipc",
                            from_session = %member_acp_session,
                            child_session = %child,
                            "session/fork succeeded"
                        );
                        return Ok((child, ContextMode::MemberFork, ContextReason::Fork));
                    }
                    Err(transport::TransportError::Agent(e)) => {
                        // 只有 agent 明确拒绝才降级；传输层故障不能伪装成「不支持 fork」。
                        tracing::warn!(
                            target: "sincearc::ipc", error = %e,
                            "session/fork failed; falling back to session/new"
                        );
                        fork_failed = true;
                    }
                    Err(e) => return Err(e.into()),
                }
            }
            None => {
                // 成员没有可 fork 的常驻会话：fork 压根没发出，
                // 不能报成 fork_failed —— 那会让用户以为 agent 拒绝过。
                let child = new_child_session(handle, cwd, mcp_servers).await?;
                return Ok((child, ContextMode::TaskOnly, ContextReason::MemberMissing));
            }
        }
    }

    let child = new_child_session(handle, cwd, mcp_servers).await?;
    let (context, reason) = plan_child(caps_fork, fork_failed);
    Ok((child, context, reason))
}

fn delegate_error_stop_reason(e: &transport::TransportError) -> Option<String> {
    let transport::TransportError::Agent(value) = e else {
        return None;
    };
    value
        .get("stopReason")
        .and_then(serde_json::Value::as_str)
        .or_else(|| {
            value
                .get("data")
                .and_then(|data| data.get("stopReason"))
                .and_then(serde_json::Value::as_str)
        })
        .map(str::to_string)
        .or_else(|| value.get("code").map(|code| code.to_string()))
}

struct DelegateEvent<'a> {
    parent_ui_session_id: &'a str,
    turn_id: &'a str,
    author_id: Option<String>,
    child_acp_session_id: &'a str,
    kind: &'a str,
    payload: &'a serde_json::Value,
    truncated: bool,
}

fn append_delegate_event(db: &db::Db, event: DelegateEvent<'_>) {
    let DelegateEvent {
        parent_ui_session_id,
        turn_id,
        author_id,
        child_acp_session_id,
        kind,
        payload,
        truncated,
    } = event;
    let input = db::EventInput {
        turn_id: turn_id.to_string(),
        author_id,
        kind: kind.to_string(),
        payload_json: payload.to_string(),
        refs: Some(serde_json::json!({ "childSession": child_acp_session_id })),
        ext: None,
        schema: None,
        source: "live".to_string(),
        truncated,
    };
    if let Err(e) = db.append_events(parent_ui_session_id, &[input]) {
        tracing::warn!(target: "sincearc::trace", error = %e, kind, "delegate 轨迹落库失败");
    }
}

/// 收尾要用的那一把东西：参数过七个就会被 clippy 拦，捆成一个结构体。
struct DelegateEnd<'a> {
    parent_ui_session_id: &'a str,
    handle_id: &'a str,
    // 父会话承载这次派活的轮次 + 这一轮是不是派活时自己开的（是就由我们收轮，别人的轮不许我们关）
    parent_turn: Option<(&'a str, bool)>,
    status: DelegateStatus,
    stop_reason: Option<String>,
    /// 轨迹刷新只用这两项定位「哪个连接、哪个子会话」
    target_profile_id: &'a str,
    child_acp_session_id: &'a str,
}

/// 敲一下「这个会话的轨迹变了」。前端只在 busy / pendingPerm 变化时重读轨迹，
/// 而派活的开始与结束都不改这两个 —— 不敲就看不到，或者要等下一轮才出现。
fn emit_trace_tick(
    bus: &Arc<crate::wire::EventBus>,
    profile_id: &str,
    child_acp_session_id: &str,
    parent_ui_session_id: &str,
) {
    let meta = crate::wire::Meta::for_session(
        profile_id.to_string(),
        child_acp_session_id.to_string(),
        Some(parent_ui_session_id.to_string()),
        None,
    );
    bus.emit_json(
        "session.trace",
        false,
        meta,
        &serde_json::json!({ "uiSessionId": parent_ui_session_id }),
    );
}

async fn finish_delegate(
    db: &Arc<db::Db>,
    delegates: &Arc<Delegates>,
    bus: &Arc<crate::wire::EventBus>,
    end: DelegateEnd<'_>,
) {
    let DelegateEnd {
        parent_ui_session_id,
        handle_id,
        parent_turn,
        status,
        stop_reason,
        target_profile_id,
        child_acp_session_id,
    } = end;
    let Some(entry) = delegates.get(handle_id).await else {
        return;
    };
    let summary = (!entry.buffer.is_empty())
        .then(|| truncate_chars(&entry.buffer, DELEGATE_SUMMARY_CHARS));
    let Some(finished) = delegates
        .finish(
            handle_id,
            status,
            summary.clone(),
            stop_reason.clone(),
        )
        .await
    else {
        return;
    };

    if let Some((turn_id, _)) = parent_turn {
        // 与 delegate 事件同一个作者：终态落在同一条支线上。
        let author_id = Some(entry.target_member_id.clone());
        let payload = serde_json::json!({
            "handleId": handle_id,
            "status": status.as_str(),
            "summary": summary,
            "elapsedMs": delegate_elapsed_ms(finished.started_at),
            "stopReason": stop_reason,
        });
        append_delegate_event(
            db,
            DelegateEvent {
                parent_ui_session_id,
                turn_id,
                author_id,
                child_acp_session_id,
                kind: "delegate_result",
                payload: &payload,
                truncated: entry.buffer.chars().count() > DELEGATE_SUMMARY_CHARS,
            },
        );
    }

    if let Some((turn_id, own_turn)) = parent_turn {
        if own_turn {
            let turn_status = match status {
                DelegateStatus::Failed => "failed",
                _ => "finished",
            };
            let turn_stop_reason = match status {
                DelegateStatus::Cancelled => Some("cancelled"),
                _ => stop_reason.as_deref(),
            };
            if let Err(e) = db.end_turn(turn_id, turn_status, turn_stop_reason) {
                tracing::warn!(target: "sincearc::trace", error = %e, "delegate 收轮失败");
            }
        }
    }

    // 终态也要敲轨迹：那一步要从「进行中」转成「回来了 · 用时」。
    emit_trace_tick(bus, target_profile_id, child_acp_session_id, parent_ui_session_id);

    // 结果事件先落库，再叫醒 wait；顺序反了会让前端在事件到达前看到终态。
    finished.done.notify_waiters();
}

#[tauri::command]
pub async fn delegate_task(
    state: State<'_, AppState>,
    parent_ui_session_id: String,
    target_member_id: String,
    task: String,
) -> Result<DelegateHandleDto, CmdError> {
    validate_delegate_task_text(&task)?;
    guard_delegate_concurrency(&state.delegates, &parent_ui_session_id).await?;

    let member = state
        .db
        .list_agent_users()
        .map_err(|e| CmdError::new(50000, format!("读 agent user 失败：{e}")))?
        .into_iter()
        .find(|user| user.id == target_member_id)
        .ok_or_else(|| CmdError::new(50700, "目标成员不存在或不在本群"))?;

    let agent = state.get(&member.profile_id).await.ok_or_else(|| {
        CmdError::new(
            50300,
            format!("目标连接未连上：{}", member.profile_id),
        )
    })?;

    // caps 以 agent_connect 写进 profile 的握手快照为准；缺失按「未知」处理。
    let profile = state
        .db
        .load_profiles()
        .map_err(|e| CmdError::new(50000, format!("读取配置失败：{e}")))?
        .into_iter()
        .find(|profile| profile.id == member.profile_id);
    let caps_fork = profile
        .as_ref()
        .and_then(|profile| profile.caps.as_ref())
        .map(|caps| caps.session_fork);
    let cwd = profile
        .as_ref()
        .map(|profile| profile.cwd.clone())
        .filter(|cwd| !cwd.trim().is_empty())
        .unwrap_or_else(|| agent.profile.default_cwd.to_string_lossy().into_owned());

    // 父会话仍用于深度守卫与这一轮的归属；fork 的目标是成员自己的常驻会话。
    let parent_acp_session = match state.routes.by_ui_session(&parent_ui_session_id).await {
        Some((acp_session_id, _)) if state.session(&acp_session_id).await.is_some() => {
            Some(acp_session_id)
        }
        _ => None,
    };

    guard_delegate_depth(&state.delegates, parent_acp_session.as_deref()).await?;

    // 子任务是替发起派活的用户干的活：MCP 工具面取父 UI 会话的生效清单（docs/mcp.md §5）。
    let mcp_servers = mcp::session_mcp_servers(state.inner(), &parent_ui_session_id).await?;
    let member_acp_session = forkable_member_session(&member.acp_session_id);
    let (child_acp_session_id, context, reason) =
        create_delegate_child(&agent, &cwd, caps_fork, member_acp_session, &mcp_servers).await?;

    state
        .routes
        .bind(
            &child_acp_session_id,
            SessionRecord {
                profile_id: member.profile_id.clone(),
                cwd: cwd.clone(),
                ui_session_id: Some(parent_ui_session_id.clone()),
                author_id: Some(member.id.clone()),
            },
        )
        .await;

    let handle_id = next_delegate_handle_id();
    let started_at = db::now();
    // 父会话里必须有一轮来承载「谁派的活」：有活动轮就挂上去，没有就为这次派活开一轮 ——
    // 派活是用户动作，与发一条消息同性质。不挂轮的后果是轨迹面板里根本看不到这次派活，
    // 而「能看到谁派的」正是这张卡的验收项。
    let (parent_turn_id, own_turn) = match parent_acp_session.as_deref() {
        Some(parent) => match state.turns.current(parent).await {
            Some(turn) => (Some(turn), false),
            None => {
                let turn = format!("turn-{}", crate::trace::now_ms());
                if let Err(e) = state
                    .db
                    .start_turn(&parent_ui_session_id, &turn, "", None, None)
                {
                    tracing::warn!(target: "sincearc::trace", error = %e, "delegate 轮次落库失败");
                }
                state.turns.start(parent, &turn).await;
                (Some(turn), true)
            }
        },
        None => (None, false),
    };
    if let Some(turn_id) = parent_turn_id.as_deref() {
        // 子会话的轨迹挂到父轮次下，author_id 由 routes 填成目标成员，形成可见支线。
        state.turns.start(&child_acp_session_id, turn_id).await;
        // 事件的作者必须是**被派活的成员**：轨迹按 author_id 分泳道，写成 NULL 会让这一步
        // 落到主 agent 名下，用户看到的就不再是「FakeMate 被派了活」那条支线。
        let author_id = Some(member.id.clone());
        let payload = serde_json::json!({
            "handleId": handle_id,
            "target": member.id,
            "targetName": member.name,
            "task": truncate_chars(&task, DELEGATE_SUMMARY_CHARS),
            "context": context,
            "reason": reason,
            "parentAcpSession": parent_acp_session,
        });
        append_delegate_event(
            &state.db,
            DelegateEvent {
                parent_ui_session_id: &parent_ui_session_id,
                turn_id,
                author_id,
                child_acp_session_id: &child_acp_session_id,
                kind: "delegate",
                payload: &payload,
                truncated: task.chars().count() > DELEGATE_SUMMARY_CHARS,
            },
        );
        // 派活不动父会话的 busy，而前端只在 busy/pendingPerm 变化时重读轨迹 ——
        // 不敲这一下，「派活给 X」这一步要等下一轮才出现（验收要求是立刻可见）。
        emit_trace_tick(&state.bus, &member.profile_id, &child_acp_session_id, &parent_ui_session_id);
    }

    // 消息流里的发起行与轨迹事件是两份记录：前者回答「这话从哪来」，后者只是过程。
    // 两者独立落库，任一份失败都不应该中断派活。
    let delegate_message_id = format!("delegate-{}", handle_id);
    let delegate_message = db::MessageInput {
        id: delegate_message_id.clone(),
        role: "user".into(),
        author_id: None,
        turn_id: parent_turn_id.clone(),
        non_turn: parent_turn_id.is_none(),
        kind: "delegate".into(),
        payload: serde_json::json!({
            "id": delegate_message_id,
            "role": "user",
            "text": task,
            "delegate": {
                "handleId": handle_id,
                "targetMemberId": member.id,
                "targetName": member.name,
                "context": context,
                "reason": reason,
            },
        }),
        refs: Some(serde_json::json!({ "childSession": child_acp_session_id })),
        ext: None,
        schema: None,
    };
    if let Err(e) = state
        .db
        .append_messages(&parent_ui_session_id, &[delegate_message])
    {
        tracing::warn!(target: "sincearc::ipc", error = %e, "delegate 发起行落库失败");
    }

    state
        .delegates
        .insert(DelegateEntry {
            handle_id: handle_id.clone(),
            parent_ui_session_id: parent_ui_session_id.clone(),
            child_acp_session_id: child_acp_session_id.clone(),
            target_member_id: member.id.clone(),
            target_name: member.name.clone(),
            profile_id: member.profile_id.clone(),
            context,
            reason,
            buffer: String::new(),
            status: DelegateStatus::Running,
            summary: None,
            stop_reason: None,
            started_at,
            done: Arc::new(tokio::sync::Notify::new()),
        })
        .await;

    let prompt_params = serde_json::json!({
        "sessionId": child_acp_session_id,
        "prompt": [{ "type": "text", "text": task }],
    });
    let proc = agent.proc.clone();
    let delegates = state.delegates.clone();
    let db_for_task = state.db.clone();
    let bus_for_task = state.bus.clone();
    let target_profile_for_task = member.profile_id.clone();
    let turns_for_task = state.turns.clone();
    let handle_for_task = handle_id.clone();
    let child_for_task = child_acp_session_id.clone();
    let parent_ui_for_task = parent_ui_session_id.clone();
    let parent_turn_for_task = parent_turn_id.clone();
    let own_turn_for_task = own_turn;
    let author_for_task = Some(member.id.clone());
    let cancels_for_task = state.cancels();
    let turn_approvals_for_task = state.turn_approvals.clone();
    // ACP 的 session/prompt 终态是这一次 request 的响应，不经过 agent_connect 的入站循环；
    // 因此终态在这里收，正文 chunk 仍由转发 task 先追加进 buffer。
    tokio::spawn(async move {
        let meta = crate::wire::Meta::for_session(
            target_profile_for_task.clone(),
            child_for_task.clone(),
            Some(parent_ui_for_task.clone()),
            author_for_task.clone(),
        );
        // 子任务也得有自己的「这一轮开始了」。不发的话前端的重放守卫会把子会话的正文
        // 全丢掉（只在 awaiting 里的会话才收 chunk），于是回答既不上屏、也不落库 ——
        // 表现就是「派活成功了，但没人知道被派的人说了什么」。
        bus_for_task.emit_json(
            "acp.prompt.started",
            true,
            meta.clone(),
            &AcpEvent::PromptStarted {
                session_id: child_for_task.clone(),
                turn_id: parent_turn_for_task.clone(),
                ui_session_id: Some(parent_ui_for_task.clone()),
                author_id: author_for_task.clone(),
            },
        );
        let result = proc
            .request("session/prompt", prompt_params, PROMPT_TIMEOUT)
            .await;
        // 终态是 request 的响应，可能比最后一批正文 chunk 先到转发 task；
        // 给一小段宽限再收 buffer，否则摘要会少掉结尾甚至整个为空。
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
        turns_for_task.end(&child_for_task).await;
        if let Some(turn_id) = parent_turn_for_task.as_deref() {
            turn_approvals_for_task
                .clear_turn(&child_for_task, turn_id)
                .await;
        }
        match &result {
            Ok(value) => {
                bus_for_task.emit_json(
                    "acp.prompt.result",
                    true,
                    meta.clone(),
                    &AcpEvent::PromptResult {
                        session_id: child_for_task.clone(),
                        ui_session_id: Some(parent_ui_for_task.clone()),
                        author_id: author_for_task.clone(),
                        result: value.clone(),
                    },
                );
            }
            Err(e) => {
                bus_for_task.emit_json(
                    "acp.prompt.failed",
                    true,
                    meta.clone(),
                    &AcpEvent::PromptFailed {
                        session_id: child_for_task.clone(),
                        ui_session_id: Some(parent_ui_for_task.clone()),
                        author_id: author_for_task.clone(),
                        msg: e.to_string(),
                    },
                );
            }
        }
        let (agent_status, stop_reason) = match result {
            Ok(value) => (
                DelegateStatus::Finished,
                value
                    .get("stopReason")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
            ),
            Err(e) => {
                tracing::warn!(
                    target: "sincearc::ipc", session = %child_for_task, error = %e,
                    "delegated prompt failed"
                );
                (DelegateStatus::Failed, delegate_error_stop_reason(&e))
            }
        };
        // 只在这里取一次：取走即清，终态之后不能再拿同一个标记影响下一轮。
        let cancelled = cancels_for_task.take(&child_for_task).await;
        let status = delegate_end_status(cancelled, agent_status);
        finish_delegate(
            &db_for_task,
            &delegates,
            &bus_for_task,
            DelegateEnd {
                parent_ui_session_id: &parent_ui_for_task,
                handle_id: &handle_for_task,
                parent_turn: parent_turn_for_task.as_deref().map(|turn| (turn, own_turn_for_task)),
                status,
                stop_reason,
                target_profile_id: &target_profile_for_task,
                child_acp_session_id: &child_for_task,
            },
        )
        .await;
    });

    Ok(DelegateHandleDto {
        handle_id,
        child_acp_session_id,
        target_member_id: member.id,
        target_name: member.name,
        context,
        reason,
    })
}

#[tauri::command]
pub async fn delegate_wait(
    state: State<'_, AppState>,
    handle_id: String,
    timeout_ms: u64,
) -> Result<DelegateOutcomeDto, CmdError> {
    wait_for_delegate(&state.delegates, &handle_id, timeout_ms).await
}

/// 取消一次派活。`session/cancel` 是 notification，送达不等于已停：
/// 这里只把请求送到目标成员那条连接上的子会话，终态仍由 promptResult / promptFailed 决定。
///
/// 不 teardown 连接：成员连接上还有 TA 自己的会话和父会话那一轮，杀连接会连带停掉别人的活。
#[tauri::command]
pub async fn delegate_cancel(
    state: State<'_, AppState>,
    handle_id: String,
) -> Result<DelegateOutcomeDto, CmdError> {
    let entry = state
        .delegates
        .get(&handle_id)
        .await
        .ok_or_else(|| CmdError::new(50704, "delegate 句柄不存在"))?;
    if entry.status != DelegateStatus::Running {
        return Ok(outcome_from_entry(&entry));
    }

    let handle = state
        .get(&entry.profile_id)
        .await
        .ok_or_else(|| CmdError::new(50300, "目标连接已断开，这次派活没有可停的对象"))?;

    // 先打标记再发通知：agent 可能立刻回终态，晚一步就区分不出「取消导致的 failed」。
    state.request_cancel(&entry.child_acp_session_id).await;
    if let Some(turn_id) = state.turns.current(&entry.child_acp_session_id).await {
        state
            .turn_approvals
            .clear_turn(&entry.child_acp_session_id, &turn_id)
            .await;
    }
    if let Err(e) = handle
        .proc
        .notify(
            "session/cancel",
            serde_json::json!({ "sessionId": entry.child_acp_session_id.clone() }),
        )
        .await
    {
        // 通知送不到也可能已经半死；这时更要让界面进入「正在停止」，等终态收尾。
        tracing::warn!(
            target: "sincearc::ipc", profile = %entry.profile_id, session = %entry.child_acp_session_id,
            error = %e, "delegate cancel notify failed"
        );
    }

    tracing::info!(
        target: "sincearc::ipc", handle = %handle_id, session = %entry.child_acp_session_id,
        target_member = %entry.target_member_id, "delegate cancel requested"
    );
    Ok(DelegateOutcomeDto {
        status: "cancelling".to_string(),
        summary: None,
        elapsed_ms: delegate_elapsed_ms(entry.started_at),
        stop_reason: None,
    })
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
    // 这次 load 是为了向哪个界面会话投递（群里 @ 成员时就是那个群）
    ui_session_id: Option<String>,
) -> Result<SessionLoadOutcome, CmdError> {
    if acp_session_id.trim().is_empty() {
        return Err(CmdError::new(50602, "session id 不能为空"));
    }
    let handle = state
        .get(&profile_id)
        .await
        .ok_or_else(|| CmdError::new(50400, "这条连接还没建立 —— 先连接它，再向成员发消息"))?;
    let live = match ui_session_id.as_deref() {
        Some(ui_id) => state
            .db
            .live_handle(ui_id)
            .map_err(|e| CmdError::new(50000, format!("读取恢复句柄失败：{e}")))?
            .filter(|h| h.acp_session_id == acp_session_id),
        None => None,
    };
    let expected_agent_name = live.as_ref().and_then(|h| h.agent_name.clone());
    let last_event_seq = live.as_ref().and_then(|h| h.last_event_seq);

    if !handle.outcome.load_session {
        return Ok(SessionLoadOutcome {
            resume: ResumeOutcome::Unavailable {
                acp_session_id,
                reason: RESUME_UNSUPPORTED.to_string(),
            },
            modes: None,
            last_event_seq,
        });
    }

    let mcp_servers =
        mcp::target_mcp_servers(state.inner(), &profile_id, ui_session_id.as_deref()).await?;
    let req = ResumeRequest {
        profile_id: &profile_id,
        acp_session_id: &acp_session_id,
        cwd: &cwd,
        ui_session_id: ui_session_id.as_deref(),
        expected_agent_name: expected_agent_name.as_deref(),
        // 成员 load 带着群会话 id，但那份 live 句柄属于群本身
        bind_ui_handle: false,
        mcp_servers: &mcp_servers,
    };
    let (resume, modes) = load_resume_handle(&state, &handle, &req).await;
    Ok(SessionLoadOutcome {
        resume,
        modes,
        last_event_seq,
    })
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct SessionPromptResult {
    pub turn_id: String,
}

#[tauri::command]
pub async fn session_prompt(
    state: State<'_, AppState>,
    session_id: String,
    text: String,
    // 这次投递来自哪个界面会话
    ui_session_id: Option<String>,
) -> Result<SessionPromptResult, CmdError> {
    if text.trim().is_empty() {
        return Err(CmdError::new(50300, "消息为空"));
    }

    let mut record = state
        .session(&session_id)
        .await
        .ok_or_else(|| CmdError::new(50300, format!("未知会话：{session_id}")))?;

    // 归属以「这一次是谁发的」为准：同一个成员会话可能被不同的群 @ 过，
    // 事件必须投给当前这次提问所在的群，而不是它上一次被绑的地方。
    if let Some(ui) = ui_session_id.clone() {
        record.ui_session_id = Some(ui.clone());
        state
            .insert_session(session_id.clone(), record.clone())
            .await;
    }
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
    // 一轮 = 一次 prompt。轨迹事件靠 turn id 归轮，prompt 之外收到的一律不落库。
    let turn_id = format!("turn-{}", crate::trace::now_ms());
    state.turns.start(&sid, &turn_id).await;
    // 注意：轮次要挂在**界面会话**下，不是 ACP 会话 id。
    // turns.session_id 外键指向 sessions(id)（UI），而这里的 session_id 是 ACP 的 ——
    // 拿错了外键就失败，表现为「事件都落了，轨迹面板却是空的」。
    if let Some(ui_sid) = record
        .ui_session_id
        .clone()
        .or_else(|| ui_session_id.clone())
    {
        if let Err(e) = state.db.start_turn(
            &ui_sid,
            &turn_id,
            "",
            record.author_id.as_deref(),
            None,
        ) {
            tracing::warn!(target: "sincearc::trace", error = %e, "轮次落库失败");
        }
    }
    let turns = state.turns.clone();
    let turn_approvals = state.turn_approvals.clone();
    let cancels = state.cancels();
    let locks = state.locks.clone();
    let bus = state.bus.clone();
    let profile_id = record.profile_id.clone();
    let sid_for_trace = sid.clone();
    let db_for_turn = state.db.clone();
    let turn_id_for_turn = turn_id.clone();
    let turn_id_for_event = turn_id.clone();
    let proc = handle.proc.clone();
    // 这三个事件必须自带归属：推送时前端可能已经切到别的会话，
    // 「当前打开的那个」不是判断依据。
    let ui_for_event = record.ui_session_id.clone().or(ui_session_id);
    let author_for_event = record.author_id.clone();

    tokio::spawn(async move {
        // 先告诉界面「这一轮开始了」，UI 据此进入生成态
        tracing::info!(target: "sincearc::ipc", "forward -> webview kind=promptStarted");
        let meta = Meta::for_session(
            profile_id.clone(),
            sid.clone(),
            ui_for_event.clone(),
            author_for_event.clone(),
        );
        bus.emit_json(
            "acp.prompt.started",
            true,
            meta.clone(),
            &AcpEvent::PromptStarted {
                session_id: sid.clone(),
                turn_id: Some(turn_id_for_event),
                ui_session_id: ui_for_event.clone(),
                author_id: author_for_event.clone(),
            },
        );

        match proc.request("session/prompt", params, PROMPT_TIMEOUT).await {
            Ok(result) => {
                let cancelled_by_user = cancels.take(&sid).await;
                let stop_reason = result
                    .get("stopReason")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string);
                let (status, stop_reason) =
                    prompt_success_outcome(cancelled_by_user, stop_reason);
                tracing::info!(target: "sincearc::ipc", session = %sid, stop = ?result.get("stopReason"), "prompt finished");
                tracing::info!(target: "sincearc::ipc", "forward -> webview kind=promptResult");
                turns.end(&sid_for_trace).await;
                turn_approvals
                    .clear_turn(&sid_for_trace, &turn_id_for_turn)
                    .await;
                end_turn_safely(
                    &db_for_turn,
                    &turn_id_for_turn,
                    status,
                    stop_reason.as_deref(),
                );
                // 一轮的终态到了：写提示锁必须一起消失，哪怕 agent 没发
                // tool_call_update（有的实现只在 tool_call 里更新状态）。
                if locks.clear(&sid_for_trace).is_some() {
                    bus.emit_json(
                        "session.lock",
                        false,
                        meta.clone(),
                        &SessionLockDto::unlocked(sid.clone(), ui_for_event.clone()),
                    );
                }
                bus.emit_json(
                    "acp.prompt.result",
                    true,
                    meta,
                    &AcpEvent::PromptResult {
                        session_id: sid,
                        ui_session_id: ui_for_event,
                        author_id: author_for_event,
                        result,
                    },
                );
            }
            Err(e) => {
                tracing::warn!(target: "sincearc::ipc", session = %sid, error = %e, "prompt failed");
                tracing::info!(target: "sincearc::ipc", "forward -> webview kind=promptFailed");
                turns.end(&sid_for_trace).await;
                turn_approvals
                    .clear_turn(&sid_for_trace, &turn_id_for_turn)
                    .await;
                // 用户按了停止之后 agent 报错，是「取消」不是「出错」：
                // 轨迹里记成 failed 会让人以为这一轮崩了。
                let cancelled_by_user = cancels.take(&sid).await;
                let (status, stop_reason) = prompt_failure_outcome(cancelled_by_user, &e);
                end_turn_safely(
                    &db_for_turn,
                    &turn_id_for_turn,
                    status,
                    stop_reason.as_deref(),
                );
                if locks.clear(&sid_for_trace).is_some() {
                    bus.emit_json(
                        "session.lock",
                        false,
                        meta.clone(),
                        &SessionLockDto::unlocked(sid.clone(), ui_for_event.clone()),
                    );
                }
                bus.emit_json(
                    "acp.prompt.failed",
                    true,
                    meta,
                    &AcpEvent::PromptFailed {
                    session_id: sid,
                    ui_session_id: ui_for_event,
                    author_id: author_for_event,
                    msg: e.to_string(),
                });
            }
        }
    });

    Ok(SessionPromptResult { turn_id })
}

fn steer_precheck(text: &str, commands: &[CommandDto]) -> Result<String, CmdError> {
    let text = text.trim();
    if text.is_empty() {
        return Err(CmdError::new(STEER_INVALID, "参数不合法"));
    }
    if !commands.iter().any(|command| command.name == "steer") {
        return Err(CmdError::new(
            STEER_NO_COMMAND,
            "这个 agent 没有声明 steer 命令",
        ));
    }
    Ok(text.to_string())
}

/// 往当前轮插一句话：发 `/steer <text>`，但不把这次请求当成新一轮。
#[tauri::command]
pub async fn session_steer(
    state: State<'_, AppState>,
    session_id: String,
    ui_session_id: String,
    text: String,
) -> Result<(), CmdError> {
    if text.trim().is_empty() {
        return Err(CmdError::new(STEER_INVALID, "参数不合法"));
    }

    let record = state.session(&session_id).await.ok_or_else(|| {
        CmdError::new(
            50300,
            format!("未知会话（不属于任何已连接 agent）：{session_id}"),
        )
    })?;
    let handle = state.get(&record.profile_id).await.ok_or_else(|| {
        CmdError::new(
            50400,
            format!("连接不存在或已断开：{}", record.profile_id),
        )
    })?;

    let commands = state.commands.commands_of(&session_id).await;
    let text = steer_precheck(&text, &commands)?;
    let params = serde_json::json!({
        "sessionId": session_id,
        "prompt": [{ "type": "text", "text": format!("/steer {text}") }],
    });
    state
        .asides
        .begin(&session_id, Some(ui_session_id.clone()))
        .await;

    let pending = match handle.proc.request_detached("session/prompt", params).await {
        Ok(pending) => pending,
        Err(e) => {
            state.asides.settle(&session_id).await;
            return Err(e.into());
        }
    };
    let proc = handle.proc.clone();
    let asides = state.asides.clone();
    let sid = session_id.clone();
    tracing::info!(
        target: "sincearc::ipc", session = %session_id, ui = %ui_session_id,
        chars = text.chars().count(), "steer sent"
    );
    tokio::spawn(async move {
        // 响应必须吃掉：它只表示 agent 收下了这次投递，不是当前那一轮的终态。
        if let Err(e) = proc.await_response(pending, PROMPT_TIMEOUT).await {
            tracing::warn!(target: "sincearc::ipc", session = %sid, error = %e, "steer request failed");
        }
        // **不要**在这里结算：回执那条 chunk 和这个响应是两条独立的报文，谁先被处理没有保证
        // （实测出现过响应先到）。留一个短窗口，等回执 chunk 自己认领（无 messageId），
        // 或者等到窗口超时兜底 —— 否则回执会掉进正文流，被当成回答的一部分落库。
        tokio::time::sleep(STEER_RECLAIM_WINDOW).await;
        asides.settle(&sid).await;
    });

    Ok(())
}

/// 请求 agent 取消当前轮。
///
/// `session/cancel` 是 notification：没有 id，也不能等回包。真正的终态仍以
/// `promptResult` / `promptFailed` 为准；这里只负责把请求送到 agent。
#[tauri::command]
pub async fn session_cancel(
    state: State<'_, AppState>,
    profile_id: String,
    session_id: String,
) -> Result<(), CmdError> {
    let handle = state
        .get(&profile_id)
        .await
        .ok_or_else(|| CmdError::new(50400, "这条连接还没建立，无法取消"))?;

    tracing::info!(
        target: "sincearc::ipc", profile = %profile_id, session = %session_id,
        "session cancel requested"
    );
    // 先打标记再发通知：agent 可能立刻回终态，晚一步就区分不出「取消导致的失败」
    state.request_cancel(&session_id).await;
    // 停止一旦发出，本轮剩余请求不再自动同意；用户重新点一次才会开启新的策略。
    if let Some(turn_id) = state.turns.current(&session_id).await {
        state
            .turn_approvals
            .clear_turn(&session_id, &turn_id)
            .await;
    }
    if let Err(e) = handle
        .proc
        .notify(
            "session/cancel",
            serde_json::json!({ "sessionId": session_id.clone() }),
        )
        .await
    {
        // 通知送不到就送到这儿：不代 agent 收尾，也不拆连接。
        // 真要收这条连接，用户走设置页的「断开连接」（那才是连接级动作）。
        tracing::warn!(
            target: "sincearc::ipc", profile = %profile_id, error = %e,
            "session cancel notify failed"
        );
    }

    // 停止请求已送达：写提示不必等一个可能永远不来的终态。
    // 若 agent 在收尾期间还发 tool_call，会重新点亮；下一轮/终态再清。
    if state.locks.clear(&session_id).is_some() {
        let record = state.routes.get(&session_id).await;
        let ui_sid = record.as_ref().and_then(|r| r.ui_session_id.clone());
        let author_id = record.as_ref().and_then(|r| r.author_id.clone());
        let meta = Meta::for_session(
            profile_id.clone(),
            session_id.clone(),
            ui_sid.clone(),
            author_id,
        );
        state
            .bus
            .emit_json("session.lock", false, meta, &SessionLockDto::unlocked(session_id.clone(), ui_sid));
    }

    // 到此为止：只发通知，**不收进程树、不拆连接**（docs/orchestration.md §6.1）。
    // `session/cancel` 是轮次级请求，取消之后那一轮起的子进程归 agent 自己收 —— 我们代它收
    // 就超出「仅做 ACP 提供的能力」，而且会把一个轮次级动作升级成连接级：
    // 同一条连接上还有别的成员会话、父会话那一轮、挂着的权限请求，全会被一起端掉。
    // 进程树只在**我们主动终止连接**时收：agent_disconnect / 换连接 / 进程退出 / 应用退出。
    // 极端情况（agent 收到 cancel 后既不回终态也不动）由用户在设置页「断开连接」兜住。
    Ok(())
}

async fn respond_permission(
    db: &db::Db,
    profile_id: &str,
    handle: &transport::AgentProcess,
    id: u64,
    outcome: serde_json::Value,
    reply: PermissionReply,
) -> Result<(), CmdError> {
    let PermissionReply { turn_id, decision } = reply;
    let option_id = normalize_optional(decision.option_id).or_else(|| {
        outcome
            .get("optionId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    });
    let option_label = normalize_optional(decision.option_label);
    let actor_member_id = normalize_optional(decision.actor_member_id);
    let note = normalize_optional(decision.note);
    let via = match decision.via.as_deref() {
        Some("auto:edits") => "auto:edits",
        Some("turn-policy") => "turn-policy",
        _ => "user",
    };
    // 裁定由前端按用户实际点的那个选项给出（allow_* / reject_*）。缺省按拒绝 —— 轨迹里
    // 宁可记成"没放行"，也不能凭缺失字段猜成放行过。
    let verdict = match decision.verdict.as_deref() {
        Some("allow") => "allow",
        _ => "reject",
    };
    match handle
        .respond(id, Ok(serde_json::json!({ "outcome": outcome })))
        .await
    {
        Ok(()) => {
            // 只有仍停在 waiting_approval 的轮才恢复 running；
            // agent 若已经先回了终态，这里不能把 finished / cancelled 盖回去。
            if let Some(turn_id) = turn_id.as_deref() {
                if let Err(e) = db.resume_turn_after_approval(turn_id) {
                    tracing::warn!(
                        target: "sincearc::trace", error = %e, turn = %turn_id,
                        "权限答完后恢复轮次状态失败"
                    );
                }
                match db.turn_context(turn_id) {
                    Ok(Some((ui_sid, turn_author))) => {
                        let actor_member_id = actor_member_id.or_else(|| turn_author.clone());
                        let payload = permission_decision_payload(
                            id,
                            turn_id,
                            PermissionTrace {
                                verdict,
                                option_id: option_id.as_deref(),
                                option_label: option_label.as_deref(),
                                actor_member_id: actor_member_id.as_deref(),
                                via,
                                note: note.as_deref(),
                            },
                        );
                        let input = db::EventInput {
                            turn_id: turn_id.to_string(),
                            author_id: turn_author,
                            kind: "permission_decision".to_string(),
                            payload_json: payload.to_string(),
                            refs: Some(serde_json::json!({ "requestId": id.to_string() })),
                            ext: None,
                            schema: None,
                            source: "live".to_string(),
                            truncated: false,
                        };
                        if let Err(e) = db.append_events(&ui_sid, &[input]) {
                            tracing::warn!(
                                target: "sincearc::trace", error = %e, turn = %turn_id,
                                "权限决定落库失败"
                            );
                        }
                    }
                    Ok(None) => tracing::warn!(
                        target: "sincearc::trace", turn = %turn_id,
                        "权限决定找不到轮次，跳过轨迹"
                    ),
                    Err(e) => tracing::warn!(
                        target: "sincearc::trace", error = %e, turn = %turn_id,
                        "读取轮次作者失败，权限决定未落库"
                    ),
                }
            } else {
                tracing::warn!(
                    target: "sincearc::trace", profile = %profile_id, id,
                    "权限决定没有关联轮次，跳过轨迹"
                );
            }
            tracing::info!(
                target: "sincearc::ipc", profile = %profile_id, id,
                "permission answered"
            );
            Ok(())
        }
        Err(e) => {
            tracing::warn!(
                target: "sincearc::ipc", profile = %profile_id, id, error = %e,
                "respond failed"
            );
            Err(CmdError::new(50502, format!("写回决定失败：{e}")))
        }
    }
}

/// 放行「本轮同类」：范围 = 当前 ACP 会话 + 当前轮 + 指定 kind。
#[tauri::command]
pub async fn permission_allow_turn(
    state: State<'_, AppState>,
    profile_id: String,
    acp_session_id: String,
    turn_id: String,
    kind: String,
) -> Result<(), CmdError> {
    if !is_known_permission_kind(&kind) {
        return Err(CmdError::new(50100, format!("未知权限类别：{kind}")));
    }
    if state.get(&profile_id).await.is_none() {
        return Err(CmdError::new(50300, "连接已断开，没有本轮可放行"));
    }
    let active_turn = state.turns.current(&acp_session_id).await;
    if active_turn.as_deref() != Some(turn_id.as_str()) {
        return Err(CmdError::new(50300, "没有本轮可放行"));
    }
    state
        .turn_approvals
        .allow(&acp_session_id, &turn_id, &kind)
        .await;
    tracing::info!(
        target: "sincearc::ipc", profile = %profile_id, acp_session = %acp_session_id,
        turn = %turn_id, %kind, "turn approval allowed"
    );
    Ok(())
}

#[tauri::command]
pub async fn permission_revoke_turn(
    state: State<'_, AppState>,
    profile_id: String,
    acp_session_id: String,
    turn_id: String,
) -> Result<bool, CmdError> {
    let removed = state
        .turn_approvals
        .revoke(&acp_session_id, &turn_id)
        .await;
    tracing::info!(
        target: "sincearc::ipc", profile = %profile_id, acp_session = %acp_session_id,
        turn = %turn_id, removed, "turn approval revoked"
    );
    Ok(removed)
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
    decision: Option<PermissionDecisionMeta>,
) -> Result<(), CmdError> {
    // 先摘登记再写回：同一个请求被点两次（双击、两个窗口）时，第二次必须被挡住，
    // 否则我们会往一个 agent 已经处理完的 id 上再写一条响应。
    let (known, turn_id) = state.pending.take_with_turn(&profile_id, id).await;
    if !known {
        return Err(CmdError::new(50500, "这个请求已失效或已被回答"));
    }
    let handle = state
        .get(&profile_id)
        .await
        .ok_or_else(|| CmdError::new(50501, "连接已断开，无法回答这个请求"))?;
    let reply = PermissionReply {
        turn_id: turn_id.clone(),
        decision: decision.unwrap_or_default(),
    };
    match respond_permission(&state.db, &profile_id, &handle.proc, id, outcome, reply).await {
        Ok(()) => Ok(()),
        Err(e) => {
            // 写不进去就把登记还回去：用户可能想再点一次，别让请求凭空消失。
            state
                .pending
                .mark_with_turn(&profile_id, id, turn_id)
                .await;
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn agent_disconnect(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<(), CmdError> {
    // 断开一个没连的东西不算错误：调用方想要的结果（没有连接）已经成立。
    // teardown 会先摘运行期记录，再回收进程树，最后清权限登记。
    if teardown_profile(state.inner(), &profile_id, "disconnect")
        .await
        .is_some()
    {
        tracing::info!(target: "sincearc::ipc", profile = %profile_id, "disconnected");
    }
    Ok(())
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
    row: db::SessionUpsert,
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
        .bind_acp_session(&id, &acp_session_id, "", "replaced")
        .map_err(|e| CmdError::new(50000, format!("绑定会话失败：{e}")))
}

/// 客户端侧日志：追到应用数据目录下的 sincearc.log。
///
/// 为什么需要它：回答"到底有没有回复、有没有写进库"这类问题，只靠 console.warn
/// 在重启后就什么都没有了（实测踩过：界面里明明有回答，库里没有，谁也说不清哪一步断的）。
#[tauri::command]
pub async fn client_log(app: tauri::AppHandle, tag: String, text: String) -> Result<(), CmdError> {
    use std::io::Write;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| CmdError::new(50700, format!("拿不到应用数据目录：{e}")))?;
    std::fs::create_dir_all(&dir).map_err(|e| CmdError::new(50700, format!("建目录失败：{e}")))?;
    let path = dir.join("sincearc.log");
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| CmdError::new(50700, format!("打开日志失败：{e}")))?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    writeln!(f, "{ts}\t{tag}\t{text}")
        .map_err(|e| CmdError::new(50700, format!("写日志失败：{e}")))?;
    Ok(())
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
        .map_err(|e| CmdError::new(50000, format!("保存消息失败：{e}")))?;

    // 会话标题：默认所有会话都叫「新会话」，用户分不清谁是谁（实测过：在两个同名会话里找错回复）。
    // 属于业务规则，所以留在命令层，db 只负责「仍叫占位名时才写」这个动作。
    if let Some(title) = title_from_first_user_message(&messages) {
        if let Err(e) = state
            .db
            .set_title_if_unnamed(&session_id, &title, DEFAULT_SESSION_TITLES)
        {
            // 标题失败不该影响消息落库，但必须留痕（stderr 会进应用日志）
            eprintln!("TITLE-ERR session={session_id} {e}");
        }
    }
    Ok(())
}

/// 默认会话标题：出现这些值时视为「还没起过名字」。
const DEFAULT_SESSION_TITLES: &[&str] = &["新会话"];

/// 首条用户消息的第一行前 30 字作为标题。没有可用文本就不改标题。
fn title_from_first_user_message(messages: &[db::MessageInput]) -> Option<String> {
    let first = messages.iter().find(|m| m.role == "user")?;
    let text = first
        .payload
        .get("text")
        .and_then(serde_json::Value::as_str)?
        .lines()
        .next()?
        .trim();
    if text.is_empty() {
        return None;
    }
    Some(text.chars().take(30).collect())
}

#[tauri::command]
pub async fn messages_load(
    state: State<'_, AppState>,
    session_id: String,
    limit: Option<i64>,
    before_seq: Option<i64>,
) -> Result<db::MessagePage, CmdError> {
    let limit = limit.unwrap_or(50).clamp(1, 500);
    state
        .db
        .load_messages_page(&session_id, limit, before_seq)
        .map_err(|e| CmdError::new(50000, format!("读取消息失败：{e}")))
}

/// 打开会话时先给一次最新的真实上下文占用；实时变化仍走 `acp.usage`。
#[tauri::command]
pub async fn session_usage(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Option<UsageDto>, CmdError> {
    let latest = state
        .db
        .latest_usage(&session_id)
        .map_err(|e| CmdError::new(50000, format!("读取上下文占用失败：{e}")))?;
    let Some((payload, author_id)) = latest else {
        return Ok(None);
    };
    let Some((used, size)) = crate::trace::usage_of(&payload) else {
        return Ok(None);
    };
    Ok(Some(UsageDto::from_raw(
        Some(session_id),
        author_id,
        used,
        size,
    )))
}

/* ---------------- 会话审批模式（编辑审批） ---------------- */
// 判据与顺序见 docs/modes-spec.md §4 / §5.1。两条铁律：
//   1. 手动选择：校验通过、且 set_mode 成功之后，才写 mode_override
//   2. 没有目标值 / 连接不支持 → 一律「不推」，不猜一个值推上去
// 错误码分区（规范 §6 要求把「配置问题」和「运行期失败」分开）：
//   50400 连接已断开   50401 连接不支持该模式   50402 set_mode 调用失败   50403 会话没报上来可选模式

/// 一次模式动作的结果。`Ok` 表示存储层已按用户意图写好；`warning` 说明为什么没推成。
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
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
mod permission_policy_tests {
    use super::{
        is_known_permission_kind, permission_decision_payload, pick_allow_option,
        turn_policy_decision, AllowOption, PermissionTrace,
    };

    #[test]
    fn unknown_kind_is_not_accepted() {
        for kind in ["edit", "delete", "move", "execute", "read", "search"] {
            assert!(is_known_permission_kind(kind), "{kind}");
        }
        for kind in ["", "unknown", "think", "fetch", "other", "EDIT"] {
            assert!(!is_known_permission_kind(kind), "{kind}");
        }
    }

    #[test]
    fn only_existing_allow_options_are_picked() {
        let rejects_only = serde_json::json!({
            "options": [
                { "kind": "reject_once", "optionId": "deny", "name": "拒绝" },
                { "kind": "reject_always", "optionId": "deny-always", "name": "总是拒绝" }
            ]
        });
        assert_eq!(pick_allow_option(&rejects_only), None, "没有 allow 项时不许自己造");

        let with_allow = serde_json::json!({
            "options": [
                { "kind": "reject_once", "optionId": "deny", "name": "拒绝" },
                { "kind": "allow_once", "optionId": "allow_once", "name": "允许一次" }
            ]
        });
        assert_eq!(
            pick_allow_option(&with_allow),
            Some(AllowOption {
                id: "allow_once".into(),
                label: Some("允许一次".into()),
            }),
            "必须用请求自带的 optionId"
        );
    }

    #[test]
    fn turn_policy_decision_writes_via_and_actor() {
        let allow = AllowOption {
            id: "allow_once".into(),
            label: Some("允许一次".into()),
        };
        let decision = turn_policy_decision(&allow, Some("member-1".into()));
        assert_eq!(decision.via.as_deref(), Some("turn-policy"));
        assert_eq!(decision.actor_member_id.as_deref(), Some("member-1"));
        assert_eq!(decision.note.as_deref(), Some("本轮同类自动允许"));

        let payload = permission_decision_payload(
            7,
            "turn-1",
            PermissionTrace {
                verdict: decision.verdict.as_deref().unwrap_or("reject"),
                option_id: decision.option_id.as_deref(),
                option_label: decision.option_label.as_deref(),
                actor_member_id: decision.actor_member_id.as_deref(),
                via: decision.via.as_deref().unwrap_or("user"),
                note: decision.note.as_deref(),
            },
        );
        assert_eq!(payload["requestId"], 7);
        assert_eq!(payload["turnId"], "turn-1");
        assert_eq!(payload["via"], "turn-policy");
        assert_eq!(payload["actorMemberId"], "member-1");
        assert_eq!(payload["optionId"], "allow_once");
        assert_eq!(payload["note"], "本轮同类自动允许");
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
            default_mcp: None,
            caps: None,
            caps_at: None,
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

#[cfg(test)]
mod turn_state_tests {
    use super::{
        prompt_failure_outcome, prompt_failure_reason, prompt_success_outcome, replay_atom_id,
        replay_batch_hash, truncate_chars, ReplayWindow,
    };
    use crate::acp::transport::TransportError;
    use crate::state::ReplayCapture;

    #[test]
    fn failed_prompt_reason_has_code_and_bounded_summary() {
        let timeout = prompt_failure_reason(&TransportError::Timeout(120));
        assert!(timeout.starts_with("timeout:"), "reason={timeout}");
        assert!(timeout.chars().count() <= 200);

        let agent = prompt_failure_reason(&TransportError::Agent(serde_json::json!({
            "code": -32603,
            "message": "boom",
        })));
        assert!(agent.starts_with("-32603:"), "reason={agent}");
        assert!(agent.contains("boom"));
    }

    #[test]
    fn failure_summary_is_truncated_at_200_chars() {
        let long = "错".repeat(500);
        let out = truncate_chars(&long, 200);
        assert_eq!(out.chars().count(), 200);
        assert!(out.ends_with('…'));
    }

    #[test]
    fn user_stop_and_agent_cancel_reason_produce_one_cancelled_outcome() {
        let (status, reason) =
            prompt_success_outcome(true, Some("cancelled".to_string()));
        assert_eq!(status, "finished");
        assert_eq!(reason.as_deref(), Some("cancelled"));

        let (status, reason) =
            prompt_success_outcome(true, Some("end_turn".to_string()));
        assert_eq!(status, "finished");
        assert_eq!(reason.as_deref(), Some("cancelled"), "用户停止优先于 agent 的 stopReason");

        let (status, reason) =
            prompt_success_outcome(false, Some("max_tokens".to_string()));
        assert_eq!(status, "finished");
        assert_eq!(reason.as_deref(), Some("max_tokens"));
    }

    #[test]
    fn prompt_error_becomes_failed_with_a_reason() {
        let (status, reason) =
            prompt_failure_outcome(false, &TransportError::Timeout(120));
        assert_eq!(status, "failed");
        assert!(reason.as_deref().is_some_and(|s| !s.is_empty()));
    }

    fn captured(kind: &str, payload: &str, at: i64) -> crate::state::Captured {
        crate::state::Captured {
            at,
            kind: kind.to_string(),
            payload_json: payload.to_string(),
            refs: None,
            ext: None,
            truncated: false,
        }
    }

    #[test]
    fn replay_batch_hash_ignores_capture_time_but_tracks_content() {
        // 同一段重放两次：at 不同（捕获时刻），内容相同 → 批次必须相同（否则会重复落库）。
        let run_a = vec![captured("thought", r#"{"text":"a"}"#, 1000)];
        let run_b = vec![captured("thought", r#"{"text":"a"}"#, 9999)];
        assert_eq!(
            replay_batch_hash("ui-1", &run_a),
            replay_batch_hash("ui-1", &run_b),
            "at 是捕获时刻，不能参与批次身份"
        );

        // 内容或顺序变了 → 必须是另一批。
        let run_c = vec![captured("thought", r#"{"text":"b"}"#, 1000)];
        assert_ne!(
            replay_batch_hash("ui-1", &run_a),
            replay_batch_hash("ui-1", &run_c)
        );
        let two = vec![
            captured("thought", r#"{"text":"a"}"#, 1000),
            captured("thought", r#"{"text":"a"}"#, 1001),
        ];
        assert_ne!(
            replay_batch_hash("ui-1", &run_a),
            replay_batch_hash("ui-1", &two),
            "同内容两条不能被当成一条"
        );
    }

    #[test]
    fn replay_atom_id_is_batch_scoped_and_ordered() {
        let batch = "0123456789abcdef";
        assert_eq!(replay_atom_id(batch, 0), "rp-0123456789abcdef-0");
        assert_ne!(replay_atom_id(batch, 0), replay_atom_id(batch, 1));
    }

    #[test]
    fn replay_window_closes_capture_on_drop() {
        let capture = std::sync::Arc::new(ReplayCapture::default());
        {
            let _window = ReplayWindow::open(capture.clone(), "acp-1".into());
            assert!(capture.is_open("acp-1"));
        }
        assert!(!capture.is_open("acp-1"), "drop 必须关窗，不能吞掉后续 live");
    }
}

#[cfg(test)]
mod delegate_tests {
    use std::sync::Arc;

    use tokio::sync::Notify;

    use super::{
        delegate_end_status, forkable_member_session, guard_delegate_concurrency,
        guard_delegate_depth, plan_child, wait_for_delegate,
    };
    use crate::state::{ContextMode, ContextReason, DelegateEntry, DelegateStatus, Delegates};

    fn entry(handle: &str, parent: &str, child: &str) -> DelegateEntry {
        DelegateEntry {
            handle_id: handle.into(),
            parent_ui_session_id: parent.into(),
            child_acp_session_id: child.into(),
            target_member_id: "member-1".into(),
            target_name: "member".into(),
            profile_id: "profile-1".into(),
            context: ContextMode::TaskOnly,
            reason: ContextReason::CapsUnknown,
            buffer: String::new(),
            status: DelegateStatus::Running,
            summary: None,
            stop_reason: None,
            started_at: crate::db::now(),
            done: Arc::new(Notify::new()),
        }
    }

    #[test]
    fn context_plan_keeps_member_fork_failure_distinct_from_unsupported_or_unknown_caps() {
        assert_eq!(
            plan_child(Some(true), false),
            (ContextMode::MemberFork, ContextReason::Fork)
        );
        assert_eq!(
            plan_child(Some(true), true),
            (ContextMode::TaskOnly, ContextReason::ForkFailed)
        );
        assert_eq!(
            plan_child(Some(false), false),
            (ContextMode::TaskOnly, ContextReason::ForkUnsupported)
        );
        assert_eq!(
            plan_child(Some(false), true),
            (ContextMode::TaskOnly, ContextReason::ForkUnsupported)
        );
        assert_eq!(
            plan_child(None, false),
            (ContextMode::TaskOnly, ContextReason::CapsUnknown)
        );
        assert_eq!(
            plan_child(None, true),
            (ContextMode::TaskOnly, ContextReason::CapsUnknown)
        );
    }

    #[test]
    fn member_fork_requires_a_non_blank_acp_session() {
        assert_eq!(forkable_member_session(""), None);
        assert_eq!(forkable_member_session(" \t\n"), None);
        assert_eq!(forkable_member_session(" x "), Some("x"));
    }

    #[test]
    fn user_cancel_wins_over_the_agents_terminal_status() {
        assert_eq!(
            delegate_end_status(true, DelegateStatus::Finished),
            DelegateStatus::Cancelled
        );
        assert_eq!(
            delegate_end_status(true, DelegateStatus::Failed),
            DelegateStatus::Cancelled
        );
        assert_eq!(
            delegate_end_status(false, DelegateStatus::Finished),
            DelegateStatus::Finished
        );
        assert_eq!(
            delegate_end_status(false, DelegateStatus::Failed),
            DelegateStatus::Failed
        );
    }

    #[tokio::test]
    async fn cancelled_is_a_terminal_delegate_status_finished_only_once() {
        let delegates = Delegates::default();
        delegates
            .insert(entry("h-cancel", "ui-parent", "child-cancel"))
            .await;

        delegates
            .finish("h-cancel", DelegateStatus::Cancelled, None, None)
            .await
            .expect("running -> cancelled");
        assert_eq!(
            delegates.get("h-cancel").await.expect("kept").status.as_str(),
            "cancelled"
        );
        assert!(
            delegates
                .finish("h-cancel", DelegateStatus::Finished, None, None)
                .await
                .is_none(),
            "终态只能写一次"
        );
    }

    #[tokio::test]
    async fn child_depth_and_fourth_running_are_rejected_with_contract_codes() {
        let delegates = Delegates::default();
        for index in 0..3 {
            delegates
                .insert(entry(
                    &format!("h-{index}"),
                    "ui-parent",
                    &format!("child-{index}"),
                ))
                .await;
        }

        let busy = guard_delegate_concurrency(&delegates, "ui-parent")
            .await
            .expect_err("第 4 个在飞任务必须被拒");
        assert_eq!(busy.code, 50703);

        // 深度按 ACP 会话判：child-0 是别人派出去的子会话，它再派活就是第 2 层
        let nested = guard_delegate_depth(&delegates, Some("child-0"))
            .await
            .expect_err("子会话不能再派活");
        assert_eq!(nested.code, 50702);
        assert!(
            guard_delegate_depth(&delegates, Some("ui-parent")).await.is_ok(),
            "普通会话可以派活"
        );
    }

    #[tokio::test]
    async fn wait_timeout_returns_timed_out_without_a_transport_or_cancel() {
        let delegates = Delegates::default();
        delegates
            .insert(entry("h-1", "ui-parent", "child-1"))
            .await;

        // wait_for_delegate 只持有 Delegates：这个测试路径里根本没有 transport/cancel 句柄。
        let outcome = wait_for_delegate(&delegates, "h-1", 5)
            .await
            .expect("running handle times out, not errors");
        assert_eq!(outcome.status, "timed_out");
        assert!(outcome.summary.is_none());
        assert_eq!(
            delegates.get("h-1").await.expect("still registered").status,
            DelegateStatus::Running,
            "超时不能结束或取消子任务"
        );
    }

    #[tokio::test]
    async fn wait_returns_terminal_summary_without_waiting_for_timeout() {
        let delegates = Delegates::default();
        delegates
            .insert(entry("h-1", "ui-parent", "child-1"))
            .await;
        delegates
            .finish(
                "h-1",
                DelegateStatus::Finished,
                Some("summary".into()),
                Some("end_turn".into()),
            )
            .await
            .expect("finish running handle");

        let outcome = wait_for_delegate(&delegates, "h-1", 0)
            .await
            .expect("terminal handle");
        assert_eq!(outcome.status, "finished");
        assert_eq!(outcome.summary.as_deref(), Some("summary"));
        assert_eq!(outcome.stop_reason.as_deref(), Some("end_turn"));
    }
}

#[cfg(test)]
mod usage_tests {
    use super::usage_percent;

    #[test]
    fn percent_never_zero_when_used() {
        assert_eq!(usage_percent(1, 1_000_000), 1);
        assert_eq!(usage_percent(0, 1_000_000), 0);
    }
}

#[cfg(test)]
mod settings_tests {
    use super::AppSettingsDto;
    use super::DEFAULT_CODE_THEME;

    #[test]
    fn settings_reject_context_over_max_with_50001() {
        let settings = AppSettingsDto {
            context_messages: 99,
            theme: "dark".into(),
            auto_approve_default: "off".into(),
            mcp_inherit_default: true,
            tween_enabled: true,
            code_theme: DEFAULT_CODE_THEME.into(),
        };
        let err = settings.validate().expect_err("99 必须被拒");
        assert_eq!(err.code, 50001);
        assert_eq!(err.msg, "附带条数超出范围（0–20）");
    }

    #[test]
    fn settings_reject_unknown_theme_with_50001() {
        let settings = AppSettingsDto {
            context_messages: 5,
            theme: "neon".into(),
            auto_approve_default: "off".into(),
            mcp_inherit_default: true,
            tween_enabled: true,
            code_theme: DEFAULT_CODE_THEME.into(),
        };
        let err = settings.validate().expect_err("未知主题必须被拒");
        assert_eq!(err.code, 50001);
        assert_eq!(err.msg, "未知主题");
    }
}


#[cfg(test)]
mod resume_decision_tests {
    use super::*;

    fn handle(agent: Option<&str>) -> db::ResumeHandle {
        db::ResumeHandle {
            acp_session_id: "acp-1".into(),
            cwd: "/w".into(),
            agent_name: agent.map(str::to_string),
            last_event_seq: Some(9),
            bound_at: 1,
        }
    }

    /// 没有句柄才是 Fresh —— 这是唯一允许"新建会话"的分支。
    #[test]
    fn no_handle_is_fresh() {
        assert_eq!(resume_decision(None, true), ResumeDecision::Fresh);
        assert_eq!(resume_decision(None, false), ResumeDecision::Fresh);
    }

    /// 有句柄但 agent 没报 loadSession：必须是 Unavailable。
    /// 退回 Fresh 就等于静默新建空会话，用户会以为历史还在。
    #[test]
    fn handle_without_load_session_is_unavailable_not_fresh() {
        let h = handle(Some("hermes"));
        match resume_decision(Some(&h), false) {
            ResumeDecision::Unavailable {
                acp_session_id,
                reason,
            } => {
                assert_eq!(acp_session_id, "acp-1");
                assert!(reason.contains("loadSession"), "原因要说清缺哪项能力：{reason}");
            }
            other => panic!("有句柄且不支持恢复时必须 Unavailable，实际 {other:?}"),
        }
    }

    #[test]
    fn handle_with_load_session_can_load() {
        let h = handle(Some("hermes"));
        assert_eq!(resume_decision(Some(&h), true), ResumeDecision::CanLoad);
    }

    #[test]
    fn successful_load_is_resumed_with_the_expected_note() {
        assert_eq!(
            resumed_outcome("acp-1", Some("hermes"), "hermes"),
            ResumeOutcome::Resumed {
                acp_session_id: "acp-1".into(),
                note: String::new(),
            }
        );
        match resumed_outcome("acp-1", Some("hermes"), "codex") {
            ResumeOutcome::Resumed { note, .. } => {
                assert!(note.contains("上下文可能不等价"), "{note}");
            }
            other => panic!("成功 load 必须是 Resumed，实际 {other:?}"),
        }
    }

    #[test]
    fn load_error_is_unavailable_with_the_original_message() {
        let err = crate::acp::transport::TransportError::Agent(serde_json::json!({
            "code": -32000,
            "message": "session not found",
        }));
        match resume_load_failed("acp-1", &err) {
            ResumeOutcome::Unavailable {
                acp_session_id,
                reason,
            } => {
                assert_eq!(acp_session_id, "acp-1");
                assert!(reason.starts_with("session/load 失败："), "{reason}");
                assert!(reason.contains("session not found"), "{reason}");
            }
            other => panic!("load 失败必须是 Unavailable，实际 {other:?}"),
        }
    }

    /// 换了 agent 才提示；同一个 agent 或老库没记录 agent 名时都不要噪音。
    #[test]
    fn note_only_when_agent_changed() {
        assert_eq!(resumed_note(Some("hermes"), "hermes"), "");
        assert_eq!(resumed_note(None, "codex"), "");
        assert_eq!(resumed_note(Some(""), "codex"), "");
        let n = resumed_note(Some("hermes"), "codex");
        assert!(n.contains("hermes") && n.contains("codex") && n.contains("不等价"), "{n}");
    }
}

#[cfg(test)]
mod steer_tests {
    use super::*;

    fn command(name: &str) -> CommandDto {
        CommandDto {
            name: name.into(),
            description: None,
            hint: None,
        }
    }

    #[test]
    fn steer_rejects_empty_text() {
        let err = steer_precheck("   ", &[command("steer")]).expect_err("空文本必须被拒");
        assert_eq!(err.code, 50001);
        assert_eq!(err.msg, "参数不合法");
    }

    #[test]
    fn steer_rejects_agent_without_command() {
        let err = steer_precheck("改成杭州西湖", &[command("status")])
            .expect_err("没有 steer 命令必须被拒");
        assert_eq!(err.code, 50404);
        assert_eq!(err.msg, "这个 agent 没有声明 steer 命令");
    }

    #[test]
    fn openable_url_only_allows_http_https_mailto() {
        for ok in [
            "https://example.com/a?b=1&c=2",
            "http://example.com",
            "HTTPS://EXAMPLE.COM",
            "mailto:someone@example.com",
            "  https://example.com/x  ",
        ] {
            assert!(is_openable_url(ok), "{ok} 应当放行");
        }
        for bad in [
            "",
            "   ",
            "javascript:alert(1)",
            "JavaScript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "file:///C:/Windows/win.ini",
            "vbscript:msgbox",
            "//evil.example/x",
            "/relative/path",
            "https:",
            "https://example.com/\nrm -rf /",
            "https://example.com/\tX",
        ] {
            assert!(!is_openable_url(bad), "{bad:?} 应当被拒");
        }
    }
}

#[cfg(test)]
mod storage_guard_tests {
    use super::*;

    const SOURCES: [(&str, &str); 3] = [
        ("src/lib.rs", include_str!("lib.rs")),
        ("src/commands.rs", include_str!("commands.rs")),
        ("src/db/mod.rs", include_str!("db/mod.rs")),
    ];

    #[test]
    fn trace_storage_has_no_age_or_count_delete() {
        let atoms_delete = concat!("DELETE ", "FROM atoms");
        let turns_delete = concat!("DELETE ", "FROM turns");
        for (path, source) in SOURCES {
            assert!(
                !source.contains(atoms_delete),
                "{path} 含 {atoms_delete}；口径：轨迹只统计不删除（§13.2）"
            );
            assert!(
                !source.contains(turns_delete),
                "{path} 含 {turns_delete}；口径：轨迹只统计不删除（§13.2）"
            );
        }
    }

    #[test]
    fn count_and_age_reasons_are_independent() {
        let now = 200 * 24 * 3600 * 1000;
        let mut stats = db::StorageStatsSnapshot {
            atom_count: STORAGE_HINT_MAX_EVENTS + 1,
            chat_count: 0,
            trace_count: STORAGE_HINT_MAX_EVENTS + 1,
            bytes: 0,
            oldest_at: Some(now - (STORAGE_HINT_MAX_DAYS + 1) * 24 * 3600 * 1000),
        };
        assert_eq!(
            storage_hint_reasons(&stats, now),
            vec!["count".to_string(), "age".to_string()]
        );

        stats.trace_count = 1;
        assert_eq!(
            storage_hint_reasons(&stats, now),
            vec!["age".to_string()]
        );
    }
}
