//! ACP 事件泵：一条连接上从 `transport::Incoming` 到出站事件总线的完整转发链路。
//!
//! 这里是「消息流事件对接」的唯一实现：起一个 task 消费入站 channel，按消息类型分派到
//! 各关注点（正文合批、轨迹落库、用量、命令列表、写锁、权限应答、合成轮状态机），
//! 最后统一经 `wire::EventBus` 套信封发给前端。
//!
//! 为什么单独一个模块而不是塞在 command 层：转发 task 拿不到 `State`，需要的是
//! 一堆共享句柄的打包（`PumpCtx`）。把这坨逻辑和 7000 行的命令层分开，事件面类型
//! （`AcpEvent` / `CommandDto` …）也归这里，命令层和 `state` 都从本模块 import，
//! 不再反向依赖命令层拿类型。
//!
//! 已知的临时耦合：权限写回 `respond_permission` 仍留在 `commands`（它返回 `CmdError`，
//! 那是命令层的错误类型），事件泵反向 `use crate::commands::respond_permission`。
//! 后续下沉方向是把它的错误类型从 `CmdError` 解耦，搬进本模块。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::acp::transport;
use crate::commands::respond_permission;
use crate::db;
use crate::lock::SessionLockDto;
use crate::state::{
    AgentTurns, Asides, Commands, Delegates, PendingRequests, ReplayCapture, Routes, TurnApprovals,
    Turns, AGENT_TURN_IDLE_MS,
};
use crate::wire::{EventBus, Meta};

// ---------------------------------------------------------------------------
// 事件面类型（前端直接消费；`wire::WireEvent.payload` 里装的就是这些）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AsideEvent {
    pub session_id: String,
    pub ui_session_id: Option<String>,
    pub text: String,
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
        /// 谁发起的这一轮：`client` / `agent`。真实轮缺省（None）即 client。
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        origin: Option<String>,
    },
    /// 一轮 prompt 正常结束（带 stopReason 等原始结果）
    PromptResult {
        session_id: String,
        #[ts(optional = nullable)]
        ui_session_id: Option<String>,
        #[ts(optional = nullable)]
        author_id: Option<String>,
        /// 谁发起的这一轮：`client` / `agent`。真实轮缺省（None）即 client。
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        origin: Option<String>,
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
    pub fn from_raw(
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

/// 整数百分比。`used > 0` 时至少给 1%，避免「明明用了一点却显示 0%」。
pub fn usage_percent(used: u64, size: u64) -> u8 {
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

// ---------------------------------------------------------------------------
// 权限辅助（自动应答与命令层手动应答共用）
// ---------------------------------------------------------------------------

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
pub fn is_known_permission_kind(kind: &str) -> bool {
    matches!(
        kind,
        "edit" | "delete" | "move" | "execute" | "read" | "search"
    )
}

#[derive(Debug, Clone, PartialEq)]
pub struct AllowOption {
    pub id: String,
    pub label: Option<String>,
}

/// 只从请求自带的 options 里挑 allow_once / allow_always；挑不到就不自动答。
pub fn pick_allow_option(params: &serde_json::Value) -> Option<AllowOption> {
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

pub fn turn_policy_decision(
    option: &AllowOption,
    actor_member_id: Option<String>,
) -> PermissionDecisionMeta {
    PermissionDecisionMeta {
        verdict: Some("allow".into()),
        option_id: Some(option.id.clone()),
        option_label: option.label.clone(),
        actor_member_id,
        note: Some("本轮同类自动允许".into()),
        via: Some("turn-policy".into()),
    }
}

pub struct PermissionTrace<'a> {
    pub verdict: &'a str,
    pub option_id: Option<&'a str>,
    pub option_label: Option<&'a str>,
    pub actor_member_id: Option<&'a str>,
    pub via: &'a str,
    pub note: Option<&'a str>,
}

pub fn permission_decision_payload(
    id: u64,
    turn_id: &str,
    trace: PermissionTrace<'_>,
) -> serde_json::Value {
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
pub struct PermissionReply {
    pub turn_id: Option<String>,
    pub decision: PermissionDecisionMeta,
}

/// 命令参数里的空串/纯空白按缺失处理：轨迹里要写 null，不写 ""。
pub fn normalize_optional(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------

/// 收轮失败不该让这一轮的结果丢掉：轨迹缺个结束时间，比整轮报错轻得多。
pub fn end_turn_safely(db: &Arc<db::Db>, turn_id: &str, status: &str, stop_reason: Option<&str>) {
    if let Err(e) = db.end_turn(turn_id, status, stop_reason) {
        tracing::warn!(target: "sincearc::trace", error = %e, "收轮失败");
    }
}

// ---------------------------------------------------------------------------
// 合成轮与转发
// ---------------------------------------------------------------------------

/// 合成轮定时器要投递的目标（属于谁的哪一轮）。聚成一个结构体是为了让
/// `spawn_agent_turn_timer` 的参数保持在 clippy 的 7 个以内。
pub struct SynthTarget {
    pub profile_id: String,
    pub session_id: String,
    pub ui_session_id: Option<String>,
    pub author_id: Option<String>,
}

/// 合成轮的唯一收尾定时器入口。每次 update / 权限变化都会起一个新定时器；
/// 旧定时器靠 `generation` 发现自己已过期，醒来后什么都不做。
pub fn spawn_agent_turn_timer(
    bus: Arc<EventBus>,
    agent_turns: AgentTurns,
    db: Arc<db::Db>,
    target: SynthTarget,
    generation: u64,
) {
    let SynthTarget {
        profile_id,
        session_id,
        ui_session_id,
        author_id,
    } = target;
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(AGENT_TURN_IDLE_MS)).await;
        let Some(end) = agent_turns.finish_if_idle(&session_id, generation) else {
            return;
        };
        // 合成轮也有 turns 行（开始时建），必须在这里收掉：
        // 否则这一轮永远停在 running，重启后历史里挂着一个没收尾的轮次。
        end_turn_safely(&db, &end.turn_id, "finished", Some("end_turn"));
        tracing::info!(
            target: "sincearc::ipc",
            session = %session_id,
            turn = %end.turn_id,
            reason = %end.reason,
            "TURN-SYNTH-END"
        );
        bus.emit_json(
            "acp.prompt.result",
            true,
            Meta::for_session(
                profile_id,
                session_id.clone(),
                ui_session_id.clone(),
                author_id.clone(),
            ),
            &AcpEvent::PromptResult {
                session_id,
                ui_session_id,
                author_id,
                origin: Some("agent".to_string()),
                result: serde_json::json!({ "stopReason": "end_turn" }),
            },
        );
    });
}

/// 转发一条 `session/update` 需要的「往哪投」上下文。
struct UpdateRoute<'a> {
    bus: &'a Arc<EventBus>,
    agent_turns: &'a AgentTurns,
    replay: &'a ReplayCapture,
    db: &'a Arc<db::Db>,
    profile_id: &'a str,
}

/// `session/update` 的唯一出口：先推进自发起轮状态机，再转发原事件。
///
/// 客户端有未决 prompt、或正处于 `session/load` 捕获窗口时，状态机不动，
/// 这条路径与改造前完全一致。
fn forward_session_update(
    route: &UpdateRoute<'_>,
    session_id: Option<String>,
    ui_session_id: Option<String>,
    author_id: Option<String>,
    params: serde_json::Value,
) {
    let UpdateRoute {
        bus,
        agent_turns,
        replay,
        db,
        profile_id,
    } = *route;
    // session/update 是标题进入本机的唯一出口：agent 推来的非空标题写回库。
    // 写失败只留痕，不影响下面的事件转发。
    if let Some(ui_sid) = ui_session_id.as_deref() {
        let update = params.get("update");
        if update
            .and_then(|u| u.get("sessionUpdate"))
            .and_then(serde_json::Value::as_str)
            == Some("session_info_update")
        {
            if let Some(title) = update
                .and_then(|u| u.get("title"))
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|title| !title.is_empty())
            {
                if let Err(e) = db.set_title_if_unnamed(ui_sid, title, db::TitleSource::Agent, &[])
                {
                    eprintln!("TITLE-ERR session={ui_sid} {e}");
                }
            }
        }
    }
    if let Some(sid) = session_id.as_deref() {
        if !replay.is_open(sid) {
            let signal = params
                .get("update")
                .and_then(|update| agent_turns.on_session_update(sid, update));
            if let Some(signal) = signal {
                if let Some(turn_id) = signal.started_turn.as_ref() {
                    // 没有客户端 prompt，就没有人替这一轮建 turns 行 —— 自己建。
                    // 缺了它，正文的 turn_id 会指向不存在的轮次，历史里这一轮会散架。
                    if let Some(ui) = ui_session_id.as_deref() {
                        if let Err(e) = db.start_turn(ui, turn_id, "", author_id.as_deref(), None) {
                            tracing::warn!(
                                target: "sincearc::ipc",
                                session = %sid,
                                turn = %turn_id,
                                error = %e,
                                "TURN-SYNTH-START 落库失败"
                            );
                        }
                    }
                    tracing::info!(
                        target: "sincearc::ipc",
                        session = %sid,
                        turn = %turn_id,
                        "TURN-SYNTH-START"
                    );
                    bus.emit_json(
                        "acp.prompt.started",
                        true,
                        Meta::for_session(
                            profile_id.to_string(),
                            sid.to_string(),
                            ui_session_id.clone(),
                            author_id.clone(),
                        ),
                        &AcpEvent::PromptStarted {
                            session_id: sid.to_string(),
                            turn_id: Some(turn_id.clone()),
                            ui_session_id: ui_session_id.clone(),
                            author_id: author_id.clone(),
                            origin: Some("agent".to_string()),
                        },
                    );
                }
                spawn_agent_turn_timer(
                    bus.clone(),
                    agent_turns.clone(),
                    db.clone(),
                    SynthTarget {
                        profile_id: profile_id.to_string(),
                        session_id: sid.to_string(),
                        ui_session_id: ui_session_id.clone(),
                        author_id: author_id.clone(),
                    },
                    signal.generation,
                );
            }
        }
    }

    let event = AcpEvent::Notification {
        method: "session/update".to_string(),
        params,
        session_id: session_id.clone(),
        ui_session_id: ui_session_id.clone(),
        author_id: author_id.clone(),
    };
    bus.emit_json(
        "acp.notification",
        true,
        Meta {
            profile_id: Some(profile_id.to_string()),
            session_id,
            ui_session_id,
            author_id,
        },
        &event,
    );
}

/// 把合批好的一段正文发出去。形状与单条 chunk 完全一致 ——
/// 前端不需要知道「这条是合并过的」，它只会收到更少的 IPC 事件。
fn emit_text(
    flush: Option<crate::coalesce::Flush>,
    bus: &Arc<EventBus>,
    agent_turns: &AgentTurns,
    replay: &ReplayCapture,
    db: &Arc<db::Db>,
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
        "sessionId": f.session_id.clone(),
        "update": update,
    });
    forward_session_update(
        &UpdateRoute {
            bus,
            agent_turns,
            replay,
            db,
            profile_id,
        },
        f.session_id,
        f.ui_session_id,
        f.author_id,
        params,
    );
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
    routes: &Routes,
    turns: &Turns,
    replay: &Arc<ReplayCapture>,
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

// ---------------------------------------------------------------------------
// 事件泵主循环
// ---------------------------------------------------------------------------

/// 一条连接的事件泵需要握住的全部句柄。
///
/// 转发 task 拿不到 `State`，所以由 `agent_connect` 把这些共享句柄 clone 出来打包。
/// 字段名刻意与循环内使用的变量名对齐，解构后循环体无需改写。
pub struct PumpCtx {
    pub proc: Arc<transport::AgentProcess>,
    pub incoming: mpsc::Receiver<transport::Incoming>,
    pub bus: Arc<EventBus>,
    pub pending: PendingRequests,
    pub routes: Routes,
    pub delegates: Arc<Delegates>,
    pub commands: Commands,
    pub asides: Asides,
    pub db: Arc<db::Db>,
    pub turns: Arc<Turns>,
    pub replay: Arc<ReplayCapture>,
    pub agent_turns: AgentTurns,
    pub turn_approvals: Arc<TurnApprovals>,
    pub locks: crate::lock::WriteLocks,
    pub profile_id: String,
}

/// 起事件泵：消费入站 channel，把每条消息分派到各关注点后经总线转发给前端。
///
/// 返回后即可继续握手后的收尾（插入进程句柄、建会话、发 hello）。泵自己是一个独立
/// task；进程输出流结束时发 `conn.exited` 并回收进程树，和改造前行为一致。
pub fn spawn_event_pump(ctx: PumpCtx) {
    let PumpCtx {
        proc,
        mut incoming,
        bus,
        pending,
        routes,
        delegates,
        commands: commands_for_task,
        asides: asides_for_task,
        db: db_for_trace,
        turns: turns_for_trace,
        replay: replay_for_trace,
        agent_turns: agent_turns_for_task,
        turn_approvals: turn_approvals_for_task,
        locks,
        profile_id: profile_for_task,
    } = ctx;
    let proc_for_task = proc.clone();

    // 循环体交给内层 task：内层 panic 只炸内层（JoinHandle 接住），外层仍能
    // 发 conn.exited 并回收进程树 —— 否则一条坏消息会拖垮整条连接、前端无感知、
    // 远端进程残留。
    let bus_cleanup = bus.clone();
    let routes_cleanup = routes.clone();
    let agent_turns_cleanup = agent_turns_for_task.clone();
    let turn_approvals_cleanup = turn_approvals_for_task.clone();
    let proc_cleanup = proc_for_task.clone();
    let profile_cleanup = profile_for_task.clone();

    tokio::spawn(async move {
        let pump = tokio::spawn(async move {
            // 正文合批（docs/ipc-contract.md §4）：chunk 是逐段来的，一条一个事件会让
            // webview 每秒处理几百次 IPC + 几百次 React 更新。在这里按 30ms / 4KB 合并，
            // 前端就只管渲染（以前是前端自己攒 40ms，等于让 UI 线程承担流控）。
            let mut text = crate::coalesce::TextCoalescer::default();
            let mut ticker = tokio::time::interval(Duration::from_millis(30));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

            loop {
                let msg = tokio::select! {
                    maybe = incoming.recv() => match maybe {
                        Some(m) => m,
                        None => break,
                    },
                    // 没有新消息时把攒着的正文发出去：否则一段说完就停住，界面像卡了
                    _ = ticker.tick() => {
                        emit_text(
                            text.flush(),
                            &bus,
                            &agent_turns_for_task,
                            &replay_for_trace,
                            &db_for_trace,
                            &profile_for_task,
                        );
                        continue;
                    }
                };

                // 正文以外的任何事件都先把缓冲冲掉，保证顺序（工具调用不能跑到它前面的文字之前）。
                // `notice` 也走这里：它不是正文，先冲掉旧缓冲，再作为普通通知原样转发给前端。
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
                    emit_text(
                        text.flush(),
                        &bus,
                        &agent_turns_for_task,
                        &replay_for_trace,
                        &db_for_trace,
                        &profile_for_task,
                    );
                }

                // 先冲正文缓冲、再落轨迹、再 emit。这里只记录 delegate 子会话的正文；
                // 父会话自己的正文仍走原来的合批路径。
                if is_text {
                    if let transport::Incoming::Notification { params, .. } = &msg {
                        if let (Some(child_sid), Some(chunk)) = (
                            params.get("sessionId").and_then(serde_json::Value::as_str),
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
                        let (session_id, ui_session_id, author_id) = routes.resolve(&params).await;
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
                                let dto = SessionLockDto::from_state(
                                    &lock_state,
                                    acp_sid.to_string(),
                                    ui_session_id.clone(),
                                );
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
                                        emit_text(
                                            text.flush(),
                                            &bus,
                                            &agent_turns_for_task,
                                            &replay_for_trace,
                                            &db_for_trace,
                                            &profile_for_task,
                                        );
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
                                &agent_turns_for_task,
                                &replay_for_trace,
                                &db_for_trace,
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
                            let acp_session_id =
                                params.get("sessionId").and_then(serde_json::Value::as_str);
                            let result = match acp_session_id {
                                Some(session_id) => match routes.get(session_id).await {
                                    Some(record) => {
                                        let cwd = PathBuf::from(record.cwd);
                                        crate::acp::fs::handle_read_request(&params, &cwd)
                                    }
                                    None => Err(serde_json::json!({
                                        "code": -32602,
                                        "message": "未知会话",
                                    })),
                                },
                                // 没有 sessionId 就连 cwd 都定位不到；交给纯函数统一报「缺少参数」。
                                None => crate::acp::fs::handle_read_request(
                                    &params,
                                    std::path::Path::new(""),
                                ),
                            };
                            match &result {
                                Ok(_) => {
                                    tracing::info!(target: "sincearc::acp", id, "fs/read_text_file ok")
                                }
                                Err(e) => tracing::warn!(
                                    target: "sincearc::acp", id, error = %e,
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
                        let waiting_turn =
                            match params.get("sessionId").and_then(serde_json::Value::as_str) {
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
                        let (session_id, ui_session_id, mut author_id) = routes.resolve(&params).await;
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
                        // 合成轮的 idle 判定要能看见「还在等授权」：请求本身也是活动，
                        // 会重置 8 秒定时器；回答后再重置一次。
                        if let Some(acp_sid) = session_id.as_deref() {
                            if let Some(generation) = agent_turns_for_task.permission_requested(
                                &profile_for_task,
                                acp_sid,
                                id,
                            ) {
                                spawn_agent_turn_timer(
                                    bus.clone(),
                                    agent_turns_for_task.clone(),
                                    db_for_trace.clone(),
                                    SynthTarget {
                                        profile_id: profile_for_task.clone(),
                                        session_id: acp_sid.to_string(),
                                        ui_session_id: ui_session_id.clone(),
                                        author_id: author_id.clone(),
                                    },
                                    generation,
                                );
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
                                && turn_approvals_for_task.covers(acp_sid, turn_id, kind).await
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
                                                decision: turn_policy_decision(
                                                    &allow,
                                                    author_id.clone(),
                                                ),
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
                                                    if let Some((answered_sid, generation)) =
                                                        agent_turns_for_task
                                                            .permission_answered(&profile_for_task, id)
                                                    {
                                                        spawn_agent_turn_timer(
                                                            bus.clone(),
                                                            agent_turns_for_task.clone(),
                                                            db_for_trace.clone(),
                                                            SynthTarget {
                                                                profile_id: profile_for_task.clone(),
                                                                session_id: answered_sid,
                                                                ui_session_id: ui_session_id.clone(),
                                                                author_id: author_id.clone(),
                                                            },
                                                            generation,
                                                        );
                                                    }
                                                    continue;
                                                }
                                                Err(e) => {
                                                    // 写不进去就把登记还回去，让用户能在弹窗里重试。
                                                    pending
                                                        .mark_with_turn(
                                                            &profile_for_task,
                                                            id,
                                                            pending_turn,
                                                        )
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
                // 两个 `session/update` choke point 都收敛到这里：正文合批走 emit_text，
                // 工具调用等其余 update 走这条通用分支。
                if let AcpEvent::Notification {
                    method,
                    params,
                    session_id,
                    ui_session_id,
                    author_id,
                } = &payload
                {
                    if method == "session/update" {
                        forward_session_update(
                            &UpdateRoute {
                                bus: &bus,
                                agent_turns: &agent_turns_for_task,
                                replay: &replay_for_trace,
                                db: &db_for_trace,
                                profile_id: &profile_for_task,
                            },
                            session_id.clone(),
                            ui_session_id.clone(),
                            author_id.clone(),
                            params.clone(),
                        );
                        continue;
                    }
                }
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
                    AcpEvent::Notification {
                        session_id,
                        ui_session_id,
                        author_id,
                        ..
                    }
                    | AcpEvent::Request {
                        session_id,
                        ui_session_id,
                        author_id,
                        ..
                    } => (session_id.clone(), ui_session_id.clone(), author_id.clone()),
                    AcpEvent::PromptStarted {
                        session_id,
                        ui_session_id,
                        author_id,
                        ..
                    }
                    | AcpEvent::PromptResult {
                        session_id,
                        ui_session_id,
                        author_id,
                        ..
                    }
                    | AcpEvent::PromptFailed {
                        session_id,
                        ui_session_id,
                        author_id,
                        ..
                    } => (
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
            emit_text(
                text.flush(),
                &bus,
                &agent_turns_for_task,
                &replay_for_trace,
                &db_for_trace,
                &profile_for_task,
            );
        });

        let pump_result = pump.await;

        // 连接已经没了：这条连接名下所有 ACP 会话的本轮策略一并作废。
        for acp_sid in routes_cleanup.acp_session_ids_of(&profile_cleanup).await {
            agent_turns_cleanup.clear_session(&acp_sid);
            turn_approvals_cleanup.clear_session(&acp_sid).await;
        }
        bus_cleanup.emit_json(
            "conn.exited",
            true,
            Meta {
                profile_id: Some(profile_cleanup.clone()),
                ..Default::default()
            },
            &AcpEvent::Exited,
        );
        // 输出流结束不等于整棵树结束：主进程可能先退出，而 cargo / tsc / node
        // 这类子孙还挂在同一进程组里。这里再走一次同侧回收；若调用方已经
        // kill 过，kill_tree 的幂等分支会立即返回。
        let _ = proc_cleanup.kill_tree("exit").await;

        // 内层 panic（而非正常走到输出流结束）时，进程树已经按上面回收，
        // 这里只留一条 error 说明「这轮是被异常打断的」。
        if let Err(join_err) = pump_result {
            if join_err.is_panic() {
                tracing::error!(
                    target: "sincearc::ipc", profile = %profile_cleanup,
                    "事件泵 panic，连接已异常退出并回收"
                );
            }
        }
    });
}
