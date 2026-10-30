//! 运行时状态：活着的 agent 进程。
//!
//! 只放「进程 + 握手结果」。会话、消息、权限请求属于会话层（E2 起），不放这里 ——
//! 一个 profile 可以连多个 session，两者的生命周期不同。

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

use crate::acp::launch::AgentProfile;
use crate::acp::{transport, InitializeOutcome, SessionModes};
use crate::commands::CommandDto;
use crate::lock::WriteLocks;

pub struct AgentHandle {
    pub proc: Arc<transport::AgentProcess>,
    pub outcome: InitializeOutcome,
    /// 起进程时用的 profile（cwd、launch 方式），session 创建要用
    pub profile: AgentProfile,
    // 事件通道不再挂在连接上：全局只有一个 EventBus（见 wire.rs），
    // 连接数变化不影响通道数，也让「事件该投给谁」只有一处判断。
}

/// 一个 ACP 会话属于哪个 profile（后续 prompt / cancel 要按它路由）
#[derive(Debug, Clone)]
pub struct SessionRecord {
    pub profile_id: String,
    pub cwd: String,
    /// 这个 ACP 会话是**哪个界面会话**发起的。
    ///
    /// 这条记录是事件归属的唯一依据：转发出站事件时按它填 `uiSessionId`，
    /// 前端不再需要「当前打开的会话」这种状态去猜。缺失（例如设置页里为成员
    /// 新建会话）就真的是 None，事件标成无归属，由前端丢弃并留痕 ——
    /// 宁可少显示一条，也不能把回答写进别的会话。
    pub ui_session_id: Option<String>,
    /// 若这个 ACP 会话是某个群成员的身份，这里是 `agent_users.id`
    pub author_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub enum ContextMode {
    MemberFork,
    TaskOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub enum ContextReason {
    /// caps 说支持，但成员没有可 fork 的常驻会话
    MemberMissing,
    Fork,
    ForkUnsupported,
    ForkFailed,
    CapsUnknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DelegateStatus {
    Running,
    Finished,
    Failed,
    Cancelled,
}

impl DelegateStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Finished => "finished",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Clone)]
pub struct DelegateEntry {
    pub handle_id: String,
    pub parent_ui_session_id: String,
    pub child_acp_session_id: String,
    pub target_member_id: String,
    pub target_name: String,
    pub profile_id: String,
    pub context: ContextMode,
    pub reason: ContextReason,
    /// 子任务的正文缓冲（由转发 task 追加），终态时取走做摘要
    pub buffer: String,
    pub status: DelegateStatus,
    pub summary: Option<String>,
    pub stop_reason: Option<String>,
    pub started_at: i64,
    /// 终态通知：wait 靠它醒来，不轮询
    pub done: Arc<tokio::sync::Notify>,
}

/// ACP 会话 → 当前这一轮的 turn id。
///
/// 轨迹事件必须挂在「那一轮」下面；没有活动轮次时收到的事件是 `session/load` 的重放，
/// 或者别的窗口发起的，不该冒充我们这一轮的历史（前端已经在丢 `DROP-REPLAY`，
/// 落库这层也要一致地跳过）。
#[derive(Default)]
pub struct Turns {
    inner: Mutex<HashMap<String, String>>,
}

/// 合成的 agent 自发起轮：连续静默这么久才允许收尾（规范 §32.3）。
pub const AGENT_TURN_IDLE_MS: u64 = 8_000;

/// `session/load` 响应回来之后的短暂抑制窗口。
///
/// load 的重放事件在响应前后到达；若响应已回、残余重放才到，就会被误当成
/// agent 自发起的一轮（历史正文被再渲染一遍、还多出一条轮次）。多等一会儿再放开。
pub const LOAD_SETTLE_SUPPRESS_MS: u64 = 2_000;

/// 客户端真实轮落终态之后，判定「尾巴」的时间上限。
///
/// 终态与最后一批 update 可能错序：终态先到、尾巴后到，尾巴会被误判成 agent
/// 自发起的下一轮，回答就记到了假轮上。窗口内**且还带着刚结束那一轮的标识**
/// （`messageId` / `toolCallId`）的 update 只转发、不开轮；
/// 带新标识的照常开轮 —— agent 在后台被唤醒干活不能被一条时间规则吞掉。
pub const CLIENT_END_TAIL_MS: u64 = 30_000;

/// 取消锁的安全阀：持有期间若连续静默这么久，说明那一段尾巴已经结束，
/// 之后的动静算新的事（agent 后台唤醒不该被一次取消永久挡住）。
pub const CANCEL_HOLD_QUIET_MS: u64 = 60_000;

/// 取消锁到点没有：`held_at` 是持有期间最后一次活动的时间。
pub fn cancel_hold_released(held_at: Option<Instant>, now: Instant) -> bool {
    held_at.is_some_and(|at| {
        now.saturating_duration_since(at) >= Duration::from_millis(CANCEL_HOLD_QUIET_MS)
    })
}

static SYNTH_TURN_SEQ: AtomicU64 = AtomicU64::new(1);

fn next_synth_turn_id() -> String {
    let seq = SYNTH_TURN_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("turn-agent-{}-{seq}", crate::trace::now_ms())
}

/// 是否应该为这条 update 合成一轮的开始。
///
/// 客户端有未决 prompt 时永远不合成；已有合成轮时也不重复开始。
/// 只有**真的带内容**的 update 能开轮：只按 kind 判定不够 —— `session/new` 之后
/// agent 会先发一条「看着像正文、其实没有正文」的首包，按 kind 就会开出一个假轮，
/// 真轮接手时又要让位，界面上那条「思考中」就被让位结果抢跑收掉。
pub fn should_synthesize_start(
    client_pending: bool,
    has_synth: bool,
    update: &serde_json::Value,
) -> bool {
    !client_pending && !has_synth && update_has_content(update)
}

/// 这条 update 自己带不带内容（不是「类型上像内容」）。
pub fn update_has_content(update: &serde_json::Value) -> bool {
    let Some(kind) = update
        .get("sessionUpdate")
        .and_then(serde_json::Value::as_str)
    else {
        return false;
    };
    match kind {
        "agent_message_chunk" | "agent_thought_chunk" => {
            content_has_payload(update.get("content"))
        }
        "tool_call" => has_text_field(update, "toolCallId"),
        // 增量更新的 id 是同一个：只要它带着 id，就说明它在描述一件真事。
        "tool_call_update" => has_text_field(update, "toolCallId"),
        _ => false,
    }
}

/// 内容块里到底有没有东西：文本块要非空白；图片/音频/资源这类没有 `text` 的，
/// 有 `type` 就算有内容；裸字符串老实现按非空白算。
fn content_has_payload(content: Option<&serde_json::Value>) -> bool {
    let Some(content) = content else {
        return false;
    };
    if let Some(text) = content.as_str() {
        return !text.trim().is_empty();
    }
    match content
        .get("type")
        .and_then(serde_json::Value::as_str)
    {
        Some("text") => content
            .get("text")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|text| !text.trim().is_empty()),
        Some(_) => true,
        None => false,
    }
}

fn has_text_field(value: &serde_json::Value, key: &str) -> bool {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .is_some_and(|text| !text.trim().is_empty())
}

/// 这一轮用过的标识。尾巴之所以能被认出来，就靠它。
#[derive(Default)]
struct TurnIds {
    messages: HashSet<String>,
    tools: HashSet<String>,
}

impl TurnIds {
    fn record(&mut self, update: &serde_json::Value) {
        if let Some(id) = update
            .get("messageId")
            .and_then(serde_json::Value::as_str)
            .filter(|id| !id.trim().is_empty())
        {
            // 消息 id 每条会话就那么几个，不清空也不会长；但给个上限免得被异常实现喂爆。
            if self.messages.len() < 64 {
                self.messages.insert(id.to_string());
            }
        }
        if let Some(id) = update
            .get("toolCallId")
            .and_then(serde_json::Value::as_str)
            .filter(|id| !id.trim().is_empty())
        {
            if self.tools.len() < 256 {
                self.tools.insert(id.to_string());
            }
        }
    }

    /// 这条 update 是不是「刚结束那一轮」的尾巴。
    fn covers(&self, update: &serde_json::Value) -> bool {
        let message = update
            .get("messageId")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|id| self.messages.contains(id));
        let tool = update
            .get("toolCallId")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|id| self.tools.contains(id));
        message || tool
    }
}

/// 三个 idle 守卫同时成立才允许合成终态。
pub fn should_synthesize_end(
    generation_unchanged: bool,
    pending_tools: usize,
    pending_perms: usize,
) -> bool {
    generation_unchanged && pending_tools == 0 && pending_perms == 0
}

/// 按工具状态维护「还在跑」的 toolCallId 集合。未知状态与缺 id 都不动计数。
fn apply_tool_update(pending: &mut HashSet<String>, update: &serde_json::Value) -> bool {
    let Some(kind) = update
        .get("sessionUpdate")
        .and_then(serde_json::Value::as_str)
    else {
        return false;
    };
    if !matches!(kind, "tool_call" | "tool_call_update") {
        return false;
    }
    let Some(tool_call_id) = update
        .get("toolCallId")
        .and_then(serde_json::Value::as_str)
        .filter(|id| !id.is_empty())
    else {
        return false;
    };
    match update.get("status").and_then(serde_json::Value::as_str) {
        Some("pending" | "in_progress") => {
            pending.insert(tool_call_id.to_string());
            true
        }
        Some("completed" | "failed") => {
            pending.remove(tool_call_id);
            true
        }
        _ => false,
    }
}

#[derive(Debug, Clone)]
struct SynthTurn {
    turn_id: String,
    pending_tools: HashSet<String>,
    generation: u64,
    last_event_at: Instant,
}

#[derive(Default)]
struct AgentTurnState {
    /// 客户端发起、还没落终态的轮（sessionPrompt 置位，PromptResult/PromptFailed 清除）
    client_pending: bool,
    /// `session/load` 正在重放：没有 prompt，但也不能把历史 update 当自发起轮。
    load_pending: bool,
    /// load 响应已回、但残余重放可能还在路上的抑制窗口（**无条件**，不看标识）。
    suppress_until: Option<Instant>,
    /// 客户端真轮终态之后的尾巴窗（**有条件的**：只挡带 `tail_ids` 标识的 update）。
    tail_until: Option<Instant>,
    /// 用户**取消**过这一轮：到下一次真 prompt（或连续静默 60 秒）之前都不许再开合成轮。
    /// 取消是用户的明确意思，之后 agent 的尾巴不该变成一轮新的问答。
    cancel_hold: bool,
    /// 取消锁持有期间最后一次活动的时间（安全阀用它数静默）。
    cancel_hold_at: Option<Instant>,
    /// 当前这一轮用过的 `messageId` / `toolCallId`（客户端轮与合成轮都记）。
    live_ids: TurnIds,
    /// 刚结束那一轮用过的标识；尾巴靠它认。
    tail_ids: TurnIds,
    /// 已经合成的自发起轮
    synth: Option<SynthTurn>,
    /// 该 ACP 会话未作答的授权请求。按 request id 去重。
    pending_perms: HashSet<u64>,
    /// 每个会话单调递增。陈旧定时器靠它识别自己已经过期。
    generation: u64,
}

/// 一次 update 推进状态机后，调用方需要做的事。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SynthSignal {
    /// Some = 这条 update 开启了新一轮，需要先发 PromptStarted。
    pub started_turn: Option<String>,
    /// 当前合成轮的代次；定时器醒来时必须拿它比对。
    pub generation: u64,
}

/// 合成轮收尾的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SynthEnd {
    pub turn_id: String,
    pub reason: String,
}

/// ACP 会话 → 自发起轮状态。
///
/// 用同步小锁而不是 tokio 锁：这里只做几次集合查询，不 await，也方便事件泵在
/// 合批 flush 的同步路径里调用。
#[derive(Clone, Default)]
pub struct AgentTurns {
    inner: Arc<StdMutex<HashMap<String, AgentTurnState>>>,
    /// (profile, request id) → ACP 会话。回答权限时命令层只有 profile + id。
    perm_sessions: Arc<StdMutex<HashMap<(String, u64), String>>>,
}

impl AgentTurns {
    /// 推进一条 `session/update`。返回 None 表示客户端轮正在飞、处于抑制窗，
    /// 或这条 update 不是轮的内容：原样转发即可，不合成。
    pub fn on_session_update(
        &self,
        acp_session_id: &str,
        update: &serde_json::Value,
    ) -> Option<SynthSignal> {
        let mut all = self.inner.lock().expect("agent turns poisoned");
        let state = all.entry(acp_session_id.to_string()).or_default();
        // 用户取消过这一轮：到下一次真 prompt 之前都不开合成轮。
        // 取消之后 agent 还在吐的尾巴属于那一轮，不该变成一条新的问答。
        // 安全阀：持有期间连续静默 60 秒，说明尾巴结束，之后的动静算新的事。
        if state.cancel_hold {
            let now = Instant::now();
            if !cancel_hold_released(state.cancel_hold_at, now) {
                state.cancel_hold_at = Some(now);
                return None;
            }
            state.cancel_hold = false;
            state.cancel_hold_at = None;
        }
        if state.client_pending || state.load_pending {
            state.live_ids.record(update);
            return None;
        }
        if state
            .suppress_until
            .is_some_and(|until| Instant::now() < until)
        {
            // session/load 的残余重放：无条件挡，它不带任何可核对的标识。
            return None;
        }
        if state
            .tail_until
            .is_some_and(|until| Instant::now() < until)
            // 窗口内**且带着刚结束那一轮的标识**：尾巴，只转发不开轮。
            // 带新标识说明是 agent 新起的事（后台被唤醒干活），照常开轮。
            && state.tail_ids.covers(update)
        {
            return None;
        }

        let can_start = should_synthesize_start(false, state.synth.is_some(), update);
        if state.synth.is_none() && !can_start {
            // 不是轮的内容：只转发，不建合成轮，也别给不存在的轮起定时器。
            return None;
        }

        state.live_ids.record(update);

        let started_turn = if can_start {
            state.generation = state.generation.saturating_add(1);
            let turn_id = next_synth_turn_id();
            state.synth = Some(SynthTurn {
                turn_id: turn_id.clone(),
                pending_tools: HashSet::new(),
                generation: state.generation,
                last_event_at: Instant::now(),
            });
            if let Some(synth) = state.synth.as_mut() {
                apply_tool_update(&mut synth.pending_tools, update);
            }
            Some(turn_id)
        } else {
            state.generation = state.generation.saturating_add(1);
            let generation = state.generation;
            if let Some(synth) = state.synth.as_mut() {
                synth.generation = generation;
                synth.last_event_at = Instant::now();
                apply_tool_update(&mut synth.pending_tools, update);
            }
            None
        };

        Some(SynthSignal {
            started_turn,
            generation: state.generation,
        })
    }

    /// 客户端真实轮开始：置 client_pending，并把已有合成轮立即让位。
    pub fn client_begin(&self, acp_session_id: &str) -> Option<SynthEnd> {
        let mut all = self.inner.lock().expect("agent turns poisoned");
        let state = all.entry(acp_session_id.to_string()).or_default();
        state.client_pending = true;
        state.cancel_hold = false;
        state.cancel_hold_at = None;
        state.suppress_until = None;
        state.tail_until = None;
        state.live_ids = TurnIds::default();
        state.synth.take().map(|synth| SynthEnd {
            turn_id: synth.turn_id,
            reason: "client-takeover".to_string(),
        })
    }

    /// 客户端真实轮终态到了：解除 busy 标记，并开启终态后的尾巴窗。
    pub fn client_end(&self, acp_session_id: &str) {
        self.client_end_with_suppress(acp_session_id, CLIENT_END_TAIL_MS);
    }

    /// 用户取消后的终态：到下一次真 prompt 之前都不许再开合成轮。
    ///
    /// 取消是用户的明确意思。之后 agent 还在吐的尾巴属于被叫停的那一轮 ——
    /// 让它变成一轮新的问答，正是「切回会话像自己聊了一句」的来路。
    pub fn client_end_cancelled(&self, acp_session_id: &str) {
        let mut all = self.inner.lock().expect("agent turns poisoned");
        let state = all.entry(acp_session_id.to_string()).or_default();
        state.client_pending = false;
        state.pending_perms.clear();
        state.cancel_hold = true;
        state.cancel_hold_at = Some(Instant::now());
        state.suppress_until = None;
        state.tail_until = None;
        state.tail_ids = std::mem::take(&mut state.live_ids);
        state.synth = None;
    }

    /// `suppress_ms` 可调只为一件事：让窗口的生效与过期能被确定性地测到（0 = 立即放开）。
    pub fn client_end_with_suppress(&self, acp_session_id: &str, suppress_ms: u64) {
        self.client_end_at(acp_session_id, Instant::now(), suppress_ms);
    }

    fn client_end_at(&self, acp_session_id: &str, now: Instant, suppress_ms: u64) {
        let mut all = self.inner.lock().expect("agent turns poisoned");
        // 用 entry 而不是 get_mut：终态可能比这条会话的第一条 update 更早落到我们手里
        // （测试里就是这种顺序）。没有记录时也必须把窗口设上，否则抑制窗根本不存在。
        let state = all.entry(acp_session_id.to_string()).or_default();
        state.client_pending = false;
        state.cancel_hold = false;
        // 真实轮已经落终态，它名下的未答授权不可能再生效。
        state.pending_perms.clear();
        // 这一轮用过的标识转成「尾巴特征」，窗口内带它们的 update 不再开轮。
        state.tail_ids = std::mem::take(&mut state.live_ids);
        // 客户端终态开的是**有条件的**尾巴窗：只有带着上一轮标识的 update 才被挡。
        // 无条件的窗口只属于 session/load 的重放（suppress_until）。
        state.tail_until = if suppress_ms == 0 {
            None
        } else {
            Some(now + Duration::from_millis(suppress_ms))
        };
        state.suppress_until = None;
        // 窗口内不能删记录：删了就等于放开了合成。
        let window_elapsed = state.tail_until.map_or(true, |until| now >= until);
        let remove = state.synth.is_none() && state.pending_perms.is_empty() && window_elapsed;
        if remove {
            all.remove(acp_session_id);
        }
    }

    /// 正常 `session/load` 开始：重放期间只转发，不合成新轮。
    pub fn load_begin(&self, acp_session_id: &str) {
        let mut all = self.inner.lock().expect("agent turns poisoned");
        all.entry(acp_session_id.to_string())
            .or_default()
            .load_pending = true;
    }

    pub fn load_end(&self, acp_session_id: &str) {
        self.load_end_with_suppress(acp_session_id, LOAD_SETTLE_SUPPRESS_MS);
    }

    /// `suppress_ms` 可调只为一件事：让「抑制窗口确实生效、且到点会放开」能被确定性地测到
    /// （0 = 立即放开）。生产路径只有 `load_end` 一个调用者。
    pub fn load_end_with_suppress(&self, acp_session_id: &str, suppress_ms: u64) {
        let mut all = self.inner.lock().expect("agent turns poisoned");
        // 抑制窗口内不能把这条记录删掉：删了就等于放开了合成。
        if let Some(state) = all.get_mut(acp_session_id) {
            state.load_pending = false;
            state.suppress_until = if suppress_ms == 0 {
                None
            } else {
                Some(Instant::now() + Duration::from_millis(suppress_ms))
            };
        }
    }

    /// 权限请求到达：登记到会话；若合成轮存在，同时重置它的 idle 定时器。
    pub fn permission_requested(
        &self,
        profile_id: &str,
        acp_session_id: &str,
        request_id: u64,
    ) -> Option<u64> {
        self.perm_sessions
            .lock()
            .expect("permission sessions poisoned")
            .insert((profile_id.to_string(), request_id), acp_session_id.to_string());

        let mut all = self.inner.lock().expect("agent turns poisoned");
        let state = all.entry(acp_session_id.to_string()).or_default();
        state.pending_perms.insert(request_id);
        state.synth.as_ref()?;
        state.generation = state.generation.saturating_add(1);
        let generation = state.generation;
        if let Some(synth) = state.synth.as_mut() {
            synth.generation = generation;
            synth.last_event_at = Instant::now();
        }
        Some(generation)
    }

    /// 权限请求已答（或自动答）：从会话的未决集合里移除。
    /// 返回 (ACP 会话, 新代次)；代次用于给合成轮重排 idle 定时器。
    pub fn permission_answered(&self, profile_id: &str, request_id: u64) -> Option<(String, u64)> {
        let acp_session_id = self
            .perm_sessions
            .lock()
            .expect("permission sessions poisoned")
            .remove(&(profile_id.to_string(), request_id))?;

        let mut all = self.inner.lock().expect("agent turns poisoned");
        let state = all.get_mut(&acp_session_id)?;
        state.pending_perms.remove(&request_id);
        if state.client_pending || state.synth.is_none() {
            return None;
        }
        state.generation = state.generation.saturating_add(1);
        let generation = state.generation;
        if let Some(synth) = state.synth.as_mut() {
            synth.generation = generation;
            synth.last_event_at = Instant::now();
        }
        Some((acp_session_id, generation))
    }

    /// 定时器醒来后调用：代次没变、没有 pending 工具、没有未答授权，才收掉合成轮。
    pub fn finish_if_idle(&self, acp_session_id: &str, generation: u64) -> Option<SynthEnd> {
        let mut all = self.inner.lock().expect("agent turns poisoned");
        let (synth, remove) = {
            let state = all.get_mut(acp_session_id)?;
            if state.client_pending || state.load_pending {
                return None;
            }
            let synth = state.synth.as_ref()?;
            debug_assert!(synth.last_event_at <= Instant::now());
            let generation_unchanged = synth.generation == generation;
            if !should_synthesize_end(
                generation_unchanged,
                synth.pending_tools.len(),
                state.pending_perms.len(),
            ) {
                return None;
            }
            let synth = state.synth.take()?;
            let remove = state.pending_perms.is_empty();
            (synth, remove)
        };
        if remove {
            all.remove(acp_session_id);
        }
        Some(SynthEnd {
            turn_id: synth.turn_id,
            reason: "idle".to_string(),
        })
    }

    pub fn clear_session(&self, acp_session_id: &str) {
        self.inner
            .lock()
            .expect("agent turns poisoned")
            .remove(acp_session_id);
        self.perm_sessions
            .lock()
            .expect("permission sessions poisoned")
            .retain(|_, session| session != acp_session_id);
    }
}

impl Turns {
    pub async fn start(&self, acp_session_id: &str, turn_id: &str) {
        self.inner
            .lock()
            .await
            .insert(acp_session_id.to_string(), turn_id.to_string());
    }

    pub async fn current(&self, acp_session_id: &str) -> Option<String> {
        self.inner.lock().await.get(acp_session_id).cloned()
    }

    pub async fn end(&self, acp_session_id: &str) {
        self.inner.lock().await.remove(acp_session_id);
    }
}

/// 「本轮同类全部允许」策略：内存态，不落库。
///
/// 键必须同时包含 ACP 会话、轮次和 kind —— 只按会话或只按轮次生效都会把授权
/// 扩大到规范 §10 明确收窄的范围之外。
#[derive(Default)]
pub struct TurnApprovals(Mutex<HashMap<(String, String), HashSet<String>>>);

impl TurnApprovals {
    pub async fn allow(&self, acp_sid: &str, turn_id: &str, kind: &str) {
        self.0
            .lock()
            .await
            .entry((acp_sid.to_string(), turn_id.to_string()))
            .or_default()
            .insert(kind.to_string());
    }

    pub async fn covers(&self, acp_sid: &str, turn_id: &str, kind: &str) -> bool {
        self.0
            .lock()
            .await
            .get(&(acp_sid.to_string(), turn_id.to_string()))
            .is_some_and(|kinds| kinds.contains(kind))
    }

    pub async fn revoke(&self, acp_sid: &str, turn_id: &str) -> bool {
        self.0
            .lock()
            .await
            .remove(&(acp_sid.to_string(), turn_id.to_string()))
            .is_some()
    }

    /// 轮结束/取消/断线时清掉该轮
    pub async fn clear_turn(&self, acp_sid: &str, turn_id: &str) {
        self.0
            .lock()
            .await
            .remove(&(acp_sid.to_string(), turn_id.to_string()));
    }

    /// 断线时清掉该连接的全部轮次
    pub async fn clear_session(&self, acp_sid: &str) {
        self.0
            .lock()
            .await
            .retain(|(session, _), _| session != acp_sid);
    }
}

/// 一次 `session/load` 重放期间捕获到的轨迹事件。
///
/// 重放没有活动轮次，不能直接走 live 落库；先收进内存，等 load 收尾后由补录命令
/// 统一写成 `source='replay'` 的原子。`payload_json` 保持解析时的字符串，补录 id
/// 直接用它算摘要，避免重新序列化导致键序变化。
#[derive(Debug, Clone)]
pub struct Captured {
    pub at: i64,
    pub kind: String,
    pub payload_json: String,
    pub refs: Option<serde_json::Value>,
    pub ext: Option<serde_json::Value>,
    pub truncated: bool,
}

/// 按 ACP 会话 id 打开的补录捕获窗口。
///
/// 窗口只在显式补录命令执行期间存在；`record_trace` 看到窗口就把事件推进缓冲并
/// 返回，既不写 live，也不因「没有活动轮次」被当成孤儿。窗口关闭后缓冲即丢。
#[derive(Default)]
pub struct ReplayCapture {
    inner: StdMutex<HashMap<String, Vec<Captured>>>,
}

impl ReplayCapture {
    /// 打开窗口。同一会话重复打开时重置为新窗口，避免上一轮残留混进本次结果。
    pub fn open(&self, acp_sid: &str) {
        self.inner
            .lock()
            .expect("replay capture poisoned")
            .insert(acp_sid.to_string(), Vec::new());
    }

    pub fn is_open(&self, acp_sid: &str) -> bool {
        self.inner
            .lock()
            .expect("replay capture poisoned")
            .contains_key(acp_sid)
    }

    /// 捕获成功返回 true；没开窗口返回 false。
    pub fn push(&self, acp_sid: &str, item: Captured) -> bool {
        let mut all = self.inner.lock().expect("replay capture poisoned");
        let Some(items) = all.get_mut(acp_sid) else {
            return false;
        };
        items.push(item);
        true
    }

    pub fn close(&self, acp_sid: &str) -> Vec<Captured> {
        self.inner
            .lock()
            .expect("replay capture poisoned")
            .remove(acp_sid)
            .unwrap_or_default()
    }
}

/// delegate 句柄登记表。与 `Turns` / `PendingRequests` 一样由后台 task 与命令层共享。
#[derive(Clone, Default)]
pub struct Delegates(Arc<Mutex<HashMap<String, DelegateEntry>>>);

impl Delegates {
    pub async fn insert(&self, entry: DelegateEntry) {
        self.0.lock().await.insert(entry.handle_id.clone(), entry);
    }

    pub async fn get(&self, handle_id: &str) -> Option<DelegateEntry> {
        self.0.lock().await.get(handle_id).cloned()
    }

    /// 只把 running 推进到终态；重复终态返回 None，避免同一个句柄写两条结果事件。
    pub async fn finish(
        &self,
        handle_id: &str,
        status: DelegateStatus,
        summary: Option<String>,
        stop_reason: Option<String>,
    ) -> Option<DelegateEntry> {
        let mut map = self.0.lock().await;
        let entry = map.get_mut(handle_id)?;
        if entry.status != DelegateStatus::Running {
            return None;
        }
        entry.status = status;
        entry.summary = summary;
        entry.stop_reason = stop_reason;
        Some(entry.clone())
    }

    pub async fn append_text(&self, handle_id: &str, chunk: &str) {
        let mut map = self.0.lock().await;
        if let Some(entry) = map.get_mut(handle_id) {
            if entry.status == DelegateStatus::Running {
                entry.buffer.push_str(chunk);
            }
        }
    }

    pub async fn by_child_acp(&self, acp_session_id: &str) -> Option<String> {
        self.0
            .lock()
            .await
            .iter()
            .find(|(_, entry)| entry.child_acp_session_id == acp_session_id)
            .map(|(handle_id, _)| handle_id.clone())
    }

    pub async fn count_running_for(&self, parent_ui_session_id: &str) -> usize {
        self.0
            .lock()
            .await
            .values()
            .filter(|entry| entry.parent_ui_session_id == parent_ui_session_id)
            .filter(|entry| entry.status == DelegateStatus::Running)
            .count()
    }

    pub async fn is_child(&self, acp_session_id: &str) -> bool {
        self.0
            .lock()
            .await
            .values()
            .any(|entry| entry.child_acp_session_id == acp_session_id)
    }
}

/// 每个 ACP 会话最近一次报上来的命令列表。
///
/// 条目随 ACP 会话 id 生命周期存在；连接退出时不做清理，断开重连会覆盖。
/// 应用退出时随内存一起消失；`session/new` / `session/load` 会重新推一份，
/// 所以既不需要落库，也不需要按 profile 反查清理。
#[derive(Clone, Default)]
pub struct Commands(Arc<Mutex<HashMap<String, Vec<CommandDto>>>>);

impl Commands {
    /// 同一会话后来的命令覆盖先前的：界面要的是「当前可用列表」，不是历史。
    pub async fn put_commands(&self, acp_session_id: &str, commands: Vec<CommandDto>) {
        self.0
            .lock()
            .await
            .insert(acp_session_id.to_string(), commands);
    }

    pub async fn commands_of(&self, acp_session_id: &str) -> Vec<CommandDto> {
        self.0
            .lock()
            .await
            .get(acp_session_id)
            .cloned()
            .unwrap_or_default()
    }
}

#[derive(Debug, Clone)]
pub struct AsideRequest {
    pub ui_session_id: Option<String>,
}

/// 已发出、还没收到 `session/prompt` 响应的插话。
///
/// 只活在内存里：它的作用是让事件泵把没有 `messageId` 的文本认成回执，
/// 并在请求真正结算后清掉，不影响任何持久化状态。
#[derive(Clone, Default)]
pub struct Asides(Arc<Mutex<HashMap<String, VecDeque<AsideRequest>>>>);

impl Asides {
    pub async fn begin(&self, acp_session_id: &str, ui_session_id: Option<String>) {
        self.0
            .lock()
            .await
            .entry(acp_session_id.to_string())
            .or_default()
            .push_back(AsideRequest { ui_session_id });
    }

    /// 返回仍待结算插话的界面会话。None = 这条 ACP 会话没有 in-flight aside。
    pub async fn pending_ui(&self, acp_session_id: &str) -> Option<Option<String>> {
        self.0
            .lock()
            .await
            .get(acp_session_id)
            .and_then(|requests| requests.front())
            .map(|request| request.ui_session_id.clone())
    }

    /// 回执已经按「无 messageId」认领掉：立刻结算，别让窗口拖到下一段正文。
    pub async fn settle_if_text_arrived(&self, acp_session_id: &str) {
        self.settle(acp_session_id).await;
    }

    /// 一次请求只有一个响应；按发起顺序结算最早的一条。
    pub async fn settle(&self, acp_session_id: &str) {
        let mut all = self.0.lock().await;
        let Some(requests) = all.get_mut(acp_session_id) else {
            return;
        };
        requests.pop_front();
        if requests.is_empty() {
            all.remove(acp_session_id);
        }
    }
}

pub struct AppState {
    /// 全局事件总线：所有域的出站事件都从这里走（wire.rs）。
    pub bus: Arc<crate::wire::EventBus>,
    agents: Mutex<HashMap<String, Arc<AgentHandle>>>,
    sessions: Mutex<HashMap<String, SessionRecord>>,
    /// 事件转发 task 也要读会话归属（它拿不到 `State`），所以单独留一份共享表。
    /// 与 `sessions` 同源写入 —— 只读它做「这一坨事件该投给谁」，不做业务判断。
    pub routes: Routes,
    /// 每个 ACP 会话打开时 agent 报上来的可选模式；推值前要拿它校验（规范 §4 规则 2）
    modes: Mutex<HashMap<String, SessionModes>>,
    /// 等用户回答的 agent 请求（目前只有 session/request_permission）
    pub pending: PendingRequests,
    /// 每个 ACP 会话当前这一轮的 id（轨迹事件靠它归轮）
    pub turns: Arc<Turns>,
    /// 客户端没发 prompt、agent 却继续推 update 时，由这里合成轮边界（§32）。
    pub agent_turns: AgentTurns,
    /// 「本轮同类全部允许」策略：内存态，轮结束/取消/断线即失效。
    pub turn_approvals: Arc<TurnApprovals>,
    /// 补录期间按 ACP 会话 id 捕获 `session/load` 重放事件；窗口关闭后缓冲即丢。
    pub replay: Arc<ReplayCapture>,
    /// 客户端拥有的 delegate 句柄；转发 task 与命令层共用。
    pub delegates: Arc<Delegates>,
    /// ACP 会话 id → 最近一次 `availableCommands`（会话状态，不落库）。
    pub commands: Commands,
    /// 已经发出、还没收到 prompt 响应的插话（内存态，只用于事件归因）。
    pub asides: Asides,
    /// 配置与会话记账（同步 SQLite，操作都是毫秒级，直接锁用）
    pub db: Arc<crate::db::Db>,
    /// 已经请求取消、还没等到终态的 ACP 会话。
    /// 用来把「取消导致的 failed」和「真失败」区分开 —— 否则用户按了停止，
    /// 轨迹里却显示这一轮出错了。
    cancel_requested: Cancels,
    /// 每个 ACP 会话正在进行的写工具调用。只用于界面提示，不参与调度。
    pub locks: WriteLocks,
}

/// 取消请求登记表（ACP 会话 id → 已请求取消）。
#[derive(Clone, Default)]
pub struct Cancels(Arc<Mutex<HashSet<String>>>);

impl Cancels {
    pub async fn mark(&self, acp_session_id: &str) {
        self.0.lock().await.insert(acp_session_id.to_string());
    }

    /// 取走标记：一轮只有一个终态，取走即清，避免影响下一轮
    pub async fn take(&self, acp_session_id: &str) -> bool {
        self.0.lock().await.remove(acp_session_id)
    }

    pub async fn clear(&self, acp_session_id: &str) {
        self.0.lock().await.remove(acp_session_id);
    }
}

/// 待回答的 agent 请求登记表。
///
/// 单独包一层是因为事件转发 task 里拿不到 `State`，却要把「这个 id 还能不能答」记下来。
/// 有了它，重复点按钮、应答过期请求、以及断连后残留的 id 都能被显式挡住，
/// 而不是往 agent 那边写一条它已经不认的响应。
/// ACP 会话 → 归属信息。转发 task 与命令层共用。
#[derive(Clone, Default)]
pub struct Routes(Arc<Mutex<HashMap<String, SessionRecord>>>);

impl Routes {
    /// 记下（或更新）某个 ACP 会话的归属
    pub async fn bind(&self, acp_session_id: &str, rec: SessionRecord) {
        self.0.lock().await.insert(acp_session_id.to_string(), rec);
    }

    /// 事件归属：只会按 ACP 会话 id 精确命中，不做模糊匹配
    pub async fn get(&self, acp_session_id: &str) -> Option<SessionRecord> {
        self.0.lock().await.get(acp_session_id).cloned()
    }

    /// 从界面会话反查它的主 ACP 会话。群成员会话也挂在同一个界面会话下，
    /// 但它们的 author_id 非空；优先选主会话（author_id 为 None）。
    pub async fn by_ui_session(&self, ui_session_id: &str) -> Option<(String, SessionRecord)> {
        self.0
            .lock()
            .await
            .iter()
            .filter(|(_, record)| record.ui_session_id.as_deref() == Some(ui_session_id))
            .min_by_key(|(_, record)| record.author_id.is_some() as u8)
            .map(|(acp_session_id, record)| (acp_session_id.clone(), record.clone()))
    }

    /// 某个连接名下的全部 ACP 会话 id。断线时据此清掉每一条会话的轮次策略。
    pub async fn acp_session_ids_of(&self, profile_id: &str) -> Vec<String> {
        self.0
            .lock()
            .await
            .iter()
            .filter(|(_, record)| record.profile_id == profile_id)
            .map(|(acp_session_id, _)| acp_session_id.clone())
            .collect()
    }
}

#[derive(Clone, Default)]
pub struct PendingRequests {
    inner: Arc<Mutex<HashMap<String, HashSet<u64>>>>,
    /// 请求 → 到达时所在的活动轮次。答完后要靠它把 waiting_approval 复原；
    /// 两轮之间收到的权限请求没有轮次，不记录。
    turn_ids: Arc<Mutex<HashMap<(String, u64), String>>>,
}

impl PendingRequests {
    pub async fn mark(&self, profile_id: &str, id: u64) {
        self.mark_with_turn(profile_id, id, None).await;
    }

    /// 登记请求，并记住它属于哪一轮（有活动轮次时）。
    pub async fn mark_with_turn(&self, profile_id: &str, id: u64, turn_id: Option<String>) {
        self.inner
            .lock()
            .await
            .entry(profile_id.to_string())
            .or_default()
            .insert(id);
        let mut turns = self.turn_ids.lock().await;
        match turn_id {
            Some(turn_id) => {
                turns.insert((profile_id.to_string(), id), turn_id);
            }
            None => {
                turns.remove(&(profile_id.to_string(), id));
            }
        }
    }

    /// 取出并移除。返回 false = 这个 id 不在册（已被回答过，或本来就不是我们发的）。
    pub async fn take(&self, profile_id: &str, id: u64) -> bool {
        self.take_with_turn(profile_id, id).await.0
    }

    /// 取出并移除，同时返回登记时记下的轮次。
    pub async fn take_with_turn(&self, profile_id: &str, id: u64) -> (bool, Option<String>) {
        let known = {
            let mut map = self.inner.lock().await;
            map.get_mut(profile_id)
                .map(|set| set.remove(&id))
                .unwrap_or(false)
        };
        let turn_id = self
            .turn_ids
            .lock()
            .await
            .remove(&(profile_id.to_string(), id));
        (known, turn_id)
    }

    pub async fn clear(&self, profile_id: &str) {
        self.inner.lock().await.remove(profile_id);
        let mut turns = self.turn_ids.lock().await;
        turns.retain(|(profile, _), _| profile.as_str() != profile_id);
    }
}

impl AppState {
    pub fn new(db: crate::db::Db) -> Self {
        Self {
            bus: Arc::new(crate::wire::EventBus::default()),
            agents: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            routes: Routes::default(),
            modes: Mutex::new(HashMap::new()),
            pending: PendingRequests::default(),
            turns: Arc::new(Turns::default()),
            agent_turns: AgentTurns::default(),
            turn_approvals: Arc::new(TurnApprovals::default()),
            replay: Arc::new(ReplayCapture::default()),
            delegates: Arc::new(Delegates::default()),
            commands: Commands::default(),
            asides: Asides::default(),
            db: Arc::new(db),
            cancel_requested: Cancels::default(),
            locks: WriteLocks::default(),
        }
    }

    /// 拿一份取消登记表的句柄：后台 task 不能借用 `State`（生命周期不够），只能持有克隆
    pub fn cancels(&self) -> Cancels {
        self.cancel_requested.clone()
    }

    /// 记下「这个 ACP 会话已被用户请求取消」
    pub async fn request_cancel(&self, acp_session_id: &str) {
        self.cancel_requested.mark(acp_session_id).await;
    }

    /// 取走取消标记：返回 true 表示这一轮的终态是取消造成的
    pub async fn take_cancel(&self, acp_session_id: &str) -> bool {
        self.cancel_requested.take(acp_session_id).await
    }

    pub async fn insert(&self, id: String, handle: Arc<AgentHandle>) {
        self.agents.lock().await.insert(id, handle);
    }

    pub async fn get(&self, id: &str) -> Option<Arc<AgentHandle>> {
        self.agents.lock().await.get(id).cloned()
    }

    /// 取出并移除（断连时用；调用方负责 kill）
    pub async fn take(&self, id: &str) -> Option<Arc<AgentHandle>> {
        self.agents.lock().await.remove(id)
    }

    pub async fn ids(&self) -> Vec<String> {
        self.agents.lock().await.keys().cloned().collect()
    }

    /// 退出兜底：把所有活着的 agent 从注册表摘走，交给调用方并发回收。
    pub async fn take_all(&self) -> Vec<Arc<AgentHandle>> {
        let mut map = self.agents.lock().await;
        map.drain().map(|(_, handle)| handle).collect()
    }

    /// 这个 profile 当前挂着的界面会话（去重）；断连降级提示要投给它们。
    pub async fn ui_sessions_of(&self, profile_id: &str) -> Vec<String> {
        let mut out: Vec<String> = self
            .sessions
            .lock()
            .await
            .values()
            .filter(|record| record.profile_id == profile_id)
            .filter_map(|record| record.ui_session_id.clone())
            .collect();
        out.sort();
        out.dedup();
        out
    }

    pub async fn insert_session(&self, session_id: String, record: SessionRecord) {
        // 两张表同源写入：`sessions` 给命令层判断归属，`routes` 给事件转发 task 查投递目标
        self.routes.bind(&session_id, record.clone()).await;
        self.sessions.lock().await.insert(session_id, record);
    }

    pub async fn session(&self, session_id: &str) -> Option<SessionRecord> {
        self.sessions.lock().await.get(session_id).cloned()
    }

    pub async fn set_modes(&self, acp_session_id: String, modes: SessionModes) {
        self.modes.lock().await.insert(acp_session_id, modes);
    }

    pub async fn modes_of(&self, acp_session_id: &str) -> Option<SessionModes> {
        self.modes.lock().await.get(acp_session_id).cloned()
    }

    /// 断连时把该 profile 名下的会话一并摘掉（进程没了，会话不可能还活着）
    pub async fn drop_sessions_of(&self, profile_id: &str) -> Vec<String> {
        let mut map = self.sessions.lock().await;
        let dead: Vec<String> = map
            .iter()
            .filter(|(_, r)| r.profile_id == profile_id)
            .map(|(k, _)| k.clone())
            .collect();
        let mut modes = self.modes.lock().await;
        for k in &dead {
            map.remove(k);
            // 进程没了，这份快照就过期了，不能留给下一次同 id 的会话复用。
            modes.remove(k);
        }
        dead
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use tokio::sync::Notify;

    use super::{
        apply_tool_update, should_synthesize_end, should_synthesize_start, update_has_content,
        AgentTurns, Cancels,
        Captured, CommandDto, Commands, ContextMode, ContextReason, DelegateEntry, DelegateStatus,
        Delegates, PendingRequests, ReplayCapture, Routes, SessionRecord, TurnApprovals,
        cancel_hold_released, CLIENT_END_TAIL_MS, CANCEL_HOLD_QUIET_MS,
    };

    fn command(name: &str) -> CommandDto {
        CommandDto {
            name: name.into(),
            description: None,
            hint: None,
        }
    }

    fn rec(ui: Option<&str>, author: Option<&str>) -> SessionRecord {
        SessionRecord {
            profile_id: "p1".into(),
            cwd: "/tmp".into(),
            ui_session_id: ui.map(str::to_string),
            author_id: author.map(str::to_string),
        }
    }

    fn update(kind: &str, tool_id: Option<&str>, status: Option<&str>) -> serde_json::Value {
        let mut value = serde_json::json!({ "sessionUpdate": kind });
        if let Some(tool_id) = tool_id {
            value["toolCallId"] = serde_json::Value::String(tool_id.to_string());
        }
        if let Some(status) = status {
            value["status"] = serde_json::Value::String(status.to_string());
        }
        value
    }

    /// 正文 chunk（带内容，才能开轮）。`message_id` 参与「尾巴」判定。
    fn chunk(kind: &str, text: &str, message_id: Option<&str>) -> serde_json::Value {
        let mut value = serde_json::json!({
            "sessionUpdate": kind,
            "content": { "type": "text", "text": text },
        });
        if let Some(id) = message_id {
            value["messageId"] = serde_json::Value::String(id.to_string());
        }
        value
    }

    #[test]
    fn synth_start_requires_no_client_prompt_and_no_existing_synth() {
        let body = chunk("agent_message_chunk", "hi", None);
        assert!(should_synthesize_start(false, false, &body));
        assert!(!should_synthesize_start(false, true, &body));
        assert!(!should_synthesize_start(true, false, &body));
        assert!(!should_synthesize_start(true, true, &body));
    }

    #[test]
    fn synth_start_requires_real_content_not_just_a_content_kind() {
        // `session/new` 之后 agent 先发的那条：kind 像正文，content 里没有正文。
        let empty = chunk("agent_message_chunk", "", None);
        assert!(!should_synthesize_start(false, false, &empty));
        let blank = chunk("agent_thought_chunk", "   \n", None);
        assert!(!should_synthesize_start(false, false, &blank));
        // 只有 kind、没有 content 字段
        assert!(!should_synthesize_start(
            false,
            false,
            &update("agent_message_chunk", None, None)
        ));
        // 非文本内容块（图片/资源）有 type 就算有内容
        assert!(update_has_content(&serde_json::json!({
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "image", "data": "…", "mimeType": "image/png" },
        })));
        // tool_call 必须有 id
        assert!(!should_synthesize_start(
            false,
            false,
            &update("tool_call", None, Some("pending"))
        ));
        assert!(should_synthesize_start(
            false,
            false,
            &update("tool_call", Some("t1"), Some("pending"))
        ));
    }

    #[test]
    fn synth_start_ignores_notification_updates() {
        for kind in [
            "session_info_update",
            "available_commands_update",
            "current_mode_update",
            "usage_update",
        ] {
            assert!(
                !should_synthesize_start(false, false, &update(kind, None, None)),
                "通知类 update 不许开轮：{kind}"
            );
        }
        assert!(!should_synthesize_start(
            false,
            false,
            &serde_json::json!({})
        ));
    }

    #[test]
    fn only_content_session_updates_start_a_synth_turn() {
        for (kind, body) in [
            ("agent_message_chunk", chunk("agent_message_chunk", "hi", None)),
            (
                "agent_thought_chunk",
                chunk("agent_thought_chunk", "想想", None),
            ),
        ] {
            let turns = AgentTurns::default();
            let started = turns
                .on_session_update("acp-1", &body)
                .and_then(|signal| signal.started_turn);
            assert!(started.is_some(), "带内容的内容类 update 必须开轮：{kind}");
        }
        for kind in ["tool_call", "tool_call_update"] {
            let turns = AgentTurns::default();
            let started = turns
                .on_session_update("acp-1", &update(kind, Some("t1"), Some("pending")))
                .and_then(|signal| signal.started_turn);
            assert!(started.is_some(), "带 id 的工具 update 必须开轮：{kind}");
        }
        for kind in [
            "session_info_update",
            "available_commands_update",
            "current_mode_update",
            "usage_update",
        ] {
            let turns = AgentTurns::default();
            let started = turns
                .on_session_update("acp-1", &update(kind, None, None))
                .and_then(|signal| signal.started_turn);
            assert!(started.is_none(), "通知类 update 不许开轮：{kind}");
        }
        // 真机现场（22:46:42）：`session/new` 之后 114µs 到的空首包。
        let turns = AgentTurns::default();
        let started = turns
            .on_session_update("acp-1", &chunk("agent_message_chunk", "", None))
            .and_then(|signal| signal.started_turn);
        assert!(started.is_none(), "空首包不许开轮");
        let turns = AgentTurns::default();
        let started = turns
            .on_session_update("acp-1", &serde_json::json!({}))
            .and_then(|signal| signal.started_turn);
        assert!(started.is_none(), "缺失 sessionUpdate 不许开轮");
    }

    #[test]
    fn tail_chunk_inside_the_window_does_not_open_a_turn() {
        let turns = AgentTurns::default();
        turns.client_begin("acp-1");
        // 真轮里的最后一段正文：此时 client_pending，标识会被记进 live_ids。
        let _ = turns.on_session_update("acp-1", &chunk("agent_message_chunk", "答", Some("m1")));
        let ended_at = Instant::now() - Duration::from_millis(500);
        turns.client_end_at("acp-1", ended_at, CLIENT_END_TAIL_MS);
        let started = turns
            .on_session_update("acp-1", &chunk("agent_message_chunk", "尾巴", Some("m1")))
            .and_then(|signal| signal.started_turn);
        assert!(started.is_none(), "同一 messageId 的迟到正文不许开轮");
    }

    #[test]
    fn a_fresh_identifier_inside_the_window_still_opens_a_turn() {
        // agent 在后台被唤醒干活：窗口内但它带的是新 messageId，不能被吞掉。
        let turns = AgentTurns::default();
        turns.client_begin("acp-1");
        let _ = turns.on_session_update("acp-1", &chunk("agent_message_chunk", "答", Some("m1")));
        turns.client_end_at("acp-1", Instant::now() - Duration::from_millis(200), CLIENT_END_TAIL_MS);
        let started = turns
            .on_session_update("acp-1", &chunk("agent_message_chunk", "新任务", Some("m2")))
            .and_then(|signal| signal.started_turn);
        assert!(started.is_some(), "新 messageId 的自发起轮必须照常开");
    }

    #[test]
    fn synth_can_start_again_after_the_client_end_window_expires() {
        let turns = AgentTurns::default();
        let ended_at = Instant::now()
            - Duration::from_millis(CLIENT_END_TAIL_MS)
            - Duration::from_millis(1);
        turns.client_end_at("acp-1", ended_at, CLIENT_END_TAIL_MS);
        let signal = turns
            .on_session_update("acp-1", &chunk("agent_message_chunk", "醒了", Some("m1")))
            .expect("窗口过期后应恢复合成");
        assert!(signal.started_turn.is_some());
    }

    #[test]
    fn cancel_holds_off_new_turns_until_the_next_client_prompt() {
        let turns = AgentTurns::default();
        turns.client_begin("acp-1");
        let _ = turns.on_session_update("acp-1", &chunk("agent_message_chunk", "答", Some("m1")));
        turns.client_end_cancelled("acp-1");
        // 取消之后，哪怕是全新的标识、哪怕等很久，也不许再开一轮。
        let started = turns
            .on_session_update("acp-1", &update("tool_call", Some("t9"), Some("pending")))
            .and_then(|signal| signal.started_turn);
        assert!(started.is_none(), "取消后不许再开合成轮");
        // 下一次真 prompt 解除锁定。
        turns.client_begin("acp-1");
        turns.client_end_at("acp-1", Instant::now(), 0);
        let signal = turns
            .on_session_update("acp-1", &chunk("agent_message_chunk", "新的一轮", Some("m2")))
            .expect("下一个真 prompt 之后必须恢复合成");
        assert!(signal.started_turn.is_some());
    }

    #[test]
    fn cancel_hold_releases_after_a_quiet_minute() {
        let now = Instant::now();
        assert!(!cancel_hold_released(Some(now), now), "刚取消时不许放开");
        assert!(
            !cancel_hold_released(
                Some(now - Duration::from_millis(CANCEL_HOLD_QUIET_MS - 1)),
                now
            ),
            "差 1ms 也不放开"
        );
        assert!(
            cancel_hold_released(
                Some(now - Duration::from_millis(CANCEL_HOLD_QUIET_MS)),
                now
            ),
            "静默满一分钟 = 尾巴结束，放开"
        );
        assert!(!cancel_hold_released(None, now));
    }

    #[test]
    fn client_begin_clears_the_client_end_window() {
        let turns = AgentTurns::default();
        turns.client_end_at(
            "acp-1",
            Instant::now() - Duration::from_millis(500),
            CLIENT_END_TAIL_MS,
        );
        turns.client_begin("acp-1");
        {
            let all = turns.inner.lock().expect("agent turns poisoned");
            let state = all.get("acp-1").expect("窗口内记录必须保留");
            assert!(state.tail_until.is_none(), "client_begin 必须清窗");
        }
        turns.client_end_at("acp-1", Instant::now(), 0);
        let signal = turns
            .on_session_update("acp-1", &chunk("agent_message_chunk", "开轮", None))
            .expect("清窗后应能开轮");
        assert!(signal.started_turn.is_some());
    }

    #[test]
    fn synth_end_requires_generation_tools_and_permissions_to_all_be_clear() {
        assert!(should_synthesize_end(true, 0, 0));
        assert!(!should_synthesize_end(false, 0, 0));
        assert!(!should_synthesize_end(true, 1, 0));
        assert!(!should_synthesize_end(true, 0, 1));
        assert!(!should_synthesize_end(true, 2, 3));
    }

    #[test]
    fn repeated_pending_tool_id_counts_once() {
        let mut pending = HashSet::new();
        assert!(apply_tool_update(
            &mut pending,
            &update("tool_call", Some("tool-1"), Some("pending"))
        ));
        assert!(apply_tool_update(
            &mut pending,
            &update("tool_call_update", Some("tool-1"), Some("in_progress"))
        ));
        assert_eq!(pending.len(), 1);
    }

    #[test]
    fn completed_tool_drops_count_and_zero_is_the_floor() {
        let mut pending = HashSet::new();
        assert!(apply_tool_update(
            &mut pending,
            &update("tool_call", Some("tool-1"), Some("pending"))
        ));
        assert!(apply_tool_update(
            &mut pending,
            &update("tool_call_update", Some("tool-1"), Some("completed"))
        ));
        assert_eq!(pending.len(), 0);
        // 重复终态是正常增量，不能减成负数。
        assert!(apply_tool_update(
            &mut pending,
            &update("tool_call_update", Some("tool-1"), Some("failed"))
        ));
        assert_eq!(pending.len(), 0);
    }

    #[test]
    fn unknown_tool_status_does_not_move_the_count() {
        let mut pending = HashSet::new();
        assert!(!apply_tool_update(
            &mut pending,
            &update("tool_call", Some("tool-1"), Some("queued"))
        ));
        assert!(pending.is_empty());
        // 普通正文更不该被当成工具。
        assert!(!apply_tool_update(
            &mut pending,
            &update("agent_message_chunk", None, Some("pending"))
        ));
        assert!(pending.is_empty());
    }

    #[test]
    fn stale_generation_cannot_end_a_newer_synth() {
        let turns = AgentTurns::default();
        let first = turns
            .on_session_update("acp-1", &chunk("agent_message_chunk", "文字", None))
            .expect("start");
        assert!(first.started_turn.is_some());
        let second = turns
            .on_session_update("acp-1", &chunk("agent_message_chunk", "文字", None))
            .expect("same synth");
        assert!(second.started_turn.is_none());
        assert_ne!(first.generation, second.generation);

        assert!(turns.finish_if_idle("acp-1", first.generation).is_none(), "旧定时器必须作废");
        assert!(turns.finish_if_idle("acp-1", second.generation).is_some());
    }

    #[test]
    fn pending_tool_blocks_synth_end_until_it_completes() {
        let turns = AgentTurns::default();
        turns
            .on_session_update("acp-1", &chunk("agent_message_chunk", "文字", None))
            .expect("start");
        let busy = turns
            .on_session_update(
                "acp-1",
                &update("tool_call_update", Some("tool-1"), Some("in_progress")),
            )
            .expect("tool");
        assert!(turns.finish_if_idle("acp-1", busy.generation).is_none());

        let done = turns
            .on_session_update(
                "acp-1",
                &update("tool_call_update", Some("tool-1"), Some("completed")),
            )
            .expect("tool done");
        assert!(turns.finish_if_idle("acp-1", done.generation).is_some());
    }

    #[test]
    fn first_event_can_already_be_a_pending_tool() {
        let turns = AgentTurns::default();
        let started = turns
            .on_session_update(
                "acp-1",
                &update("tool_call", Some("tool-1"), Some("pending")),
            )
            .expect("start");
        assert!(turns.finish_if_idle("acp-1", started.generation).is_none());
    }

    #[test]
    fn pending_permission_blocks_synth_end_until_answered() {
        let turns = AgentTurns::default();
        turns
            .on_session_update("acp-1", &chunk("agent_message_chunk", "文字", None))
            .expect("start");
        let waiting = turns
            .permission_requested("profile-1", "acp-1", 42)
            .expect("synth timer reset");
        assert!(turns.finish_if_idle("acp-1", waiting).is_none());

        let (answered_sid, generation) = turns
            .permission_answered("profile-1", 42)
            .expect("answer clears pending");
        assert_eq!(answered_sid, "acp-1");
        assert!(turns.finish_if_idle("acp-1", generation).is_some());
    }

    #[test]
    fn client_takeover_ends_synth_immediately() {
        let turns = AgentTurns::default();
        turns
            .on_session_update("acp-1", &chunk("agent_message_chunk", "文字", None))
            .expect("start");
        let end = turns.client_begin("acp-1").expect("takeover ends synth");
        assert_eq!(end.reason, "client-takeover");
        assert!(turns
            .on_session_update("acp-1", &chunk("agent_message_chunk", "文字", None))
            .is_none(), "client_pending 为真时必须原样转发");
    }

    #[test]
    fn session_load_replay_does_not_synthesize_a_turn() {
        let turns = AgentTurns::default();
        turns.load_begin("acp-1");
        assert!(turns
            .on_session_update("acp-1", &chunk("agent_message_chunk", "文字", None))
            .is_none());
        // 响应已回、残余重放还在路上：抑制窗口内也不能合成，否则历史正文会被再说一遍。
        turns.load_end("acp-1");
        assert!(turns
            .on_session_update("acp-1", &chunk("agent_message_chunk", "文字", None))
            .is_none());
    }

    #[test]
    fn session_load_release_synthesizes_once_window_passes() {
        let turns = AgentTurns::default();
        turns.load_begin("acp-1");
        turns.load_end_with_suppress("acp-1", 0);
        assert!(turns
            .on_session_update("acp-1", &chunk("agent_message_chunk", "文字", None))
            .is_some());
    }

    fn delegate(handle: &str, parent: &str, child: &str, status: DelegateStatus) -> DelegateEntry {
        DelegateEntry {
            handle_id: handle.into(),
            parent_ui_session_id: parent.into(),
            child_acp_session_id: child.into(),
            target_member_id: "u-1".into(),
            target_name: "one".into(),
            profile_id: "p1".into(),
            context: ContextMode::TaskOnly,
            reason: ContextReason::CapsUnknown,
            buffer: String::new(),
            status,
            summary: None,
            stop_reason: None,
            started_at: 1,
            done: Arc::new(Notify::new()),
        }
    }

    #[tokio::test]
    async fn routes_hit_only_the_exact_acp_session() {
        let routes = Routes::default();
        routes.bind("acp-a", rec(Some("ui-a"), None)).await;
        routes.bind("acp-b", rec(Some("ui-b"), Some("u-2"))).await;

        assert_eq!(
            routes.get("acp-a").await.and_then(|r| r.ui_session_id),
            Some("ui-a".into())
        );
        assert_eq!(
            routes.get("acp-b").await.and_then(|r| r.author_id),
            Some("u-2".into())
        );
        // 查不到就是查不到：不许模糊命中别的会话（这正是以前串消息的成因）
        assert!(routes.get("acp").await.is_none());
        assert!(routes.get("acp-a-suffix").await.is_none());
    }

    #[tokio::test]
    async fn reverse_route_prefers_the_main_session_not_a_member() {
        let routes = Routes::default();
        routes.bind("acp-member", rec(Some("ui-a"), Some("u-1"))).await;
        routes.bind("acp-main", rec(Some("ui-a"), None)).await;

        let (acp, record) = routes.by_ui_session("ui-a").await.expect("bound");
        assert_eq!(acp, "acp-main");
        assert!(record.author_id.is_none());
    }

    #[tokio::test]
    async fn delegates_track_buffer_running_count_and_terminal_state() {
        let delegates = Delegates::default();
        delegates
            .insert(delegate("h1", "ui-a", "child-1", DelegateStatus::Running))
            .await;

        assert_eq!(delegates.by_child_acp("child-1").await.as_deref(), Some("h1"));
        assert!(delegates.is_child("child-1").await);
        assert_eq!(delegates.count_running_for("ui-a").await, 1);

        delegates.append_text("h1", "hello").await;
        delegates
            .finish(
                "h1",
                DelegateStatus::Finished,
                Some("hello".into()),
                Some("end_turn".into()),
            )
            .await
            .expect("running -> finished");
        assert_eq!(delegates.count_running_for("ui-a").await, 0);

        let entry = delegates.get("h1").await.expect("kept for wait");
        assert_eq!(entry.status, DelegateStatus::Finished);
        assert_eq!(entry.summary.as_deref(), Some("hello"));
        assert_eq!(entry.stop_reason.as_deref(), Some("end_turn"));
        assert!(
            delegates
                .finish("h1", DelegateStatus::Failed, None, None)
                .await
                .is_none(),
            "终态只能写一次"
        );
    }

    #[tokio::test]
    async fn rebinding_moves_the_target_not_duplicates() {
        let routes = Routes::default();
        routes.bind("acp-a", rec(Some("ui-a"), None)).await;
        // 同一个成员会话被另一个群 @：归属以最新一次投递为准
        routes.bind("acp-a", rec(Some("ui-b"), Some("u-1"))).await;
        let got = routes.get("acp-a").await.expect("bound");
        assert_eq!(got.ui_session_id.as_deref(), Some("ui-b"));
        assert_eq!(got.author_id.as_deref(), Some("u-1"));
    }

    #[tokio::test]
    async fn no_ui_binding_stays_none() {
        let routes = Routes::default();
        // 设置页为成员建会话：不属于任何界面会话
        routes.bind("acp-x", rec(None, None)).await;
        let got = routes.get("acp-x").await.expect("bound");
        assert!(got.ui_session_id.is_none());
    }

    #[tokio::test]
    async fn pending_is_single_use() {
        let pending = PendingRequests::default();
        pending.mark("p1", 7).await;

        // 第一次取走算成功
        assert!(pending.take("p1", 7).await);
        // 第二次必须是 false：界面双击不能往 agent 写第二条响应
        assert!(!pending.take("p1", 7).await);
    }

    #[tokio::test]
    async fn pending_is_scoped_per_profile() {
        let pending = PendingRequests::default();
        pending.mark("p1", 7).await;
        // 同一个 id 号在另一个连接上不算数（JSON-RPC id 只在单条连接内唯一）
        assert!(!pending.take("p2", 7).await);
        assert!(pending.take("p1", 7).await);
    }

    #[tokio::test]
    async fn pending_keeps_turn_context_for_approval_resume() {
        let pending = PendingRequests::default();
        pending
            .mark_with_turn("p1", 7, Some("turn-1".into()))
            .await;

        let (known, turn_id) = pending.take_with_turn("p1", 7).await;
        assert!(known);
        assert_eq!(turn_id.as_deref(), Some("turn-1"));
        // 取走即清，下一次不存在
        assert_eq!(pending.take_with_turn("p1", 7).await, (false, None));
    }

    #[tokio::test]
    async fn turn_approvals_are_scoped_by_session_turn_and_kind() {
        let approvals = TurnApprovals::default();
        approvals.allow("acp-1", "turn-1", "edit").await;

        assert!(approvals.covers("acp-1", "turn-1", "edit").await);
        assert!(!approvals.covers("acp-1", "turn-2", "edit").await, "换轮不命中");
        assert!(!approvals.covers("acp-1", "turn-1", "execute").await, "换 kind 不命中");
        assert!(!approvals.covers("acp-2", "turn-1", "edit").await, "换会话不命中");
    }

    #[tokio::test]
    async fn turn_approvals_revoke_clears_the_turn_policy() {
        let approvals = TurnApprovals::default();
        approvals.allow("acp-1", "turn-1", "edit").await;

        assert!(approvals.revoke("acp-1", "turn-1").await);
        assert!(!approvals.covers("acp-1", "turn-1", "edit").await);
        assert!(!approvals.revoke("acp-1", "turn-1").await, "第二次撤销返回 false");
    }

    #[tokio::test]
    async fn turn_approvals_clear_turn_and_session_stop_matching() {
        let approvals = TurnApprovals::default();
        approvals.allow("acp-1", "turn-1", "edit").await;
        approvals.allow("acp-1", "turn-1", "execute").await;
        approvals.allow("acp-1", "turn-2", "edit").await;
        approvals.allow("acp-2", "turn-1", "edit").await;

        approvals.clear_turn("acp-1", "turn-1").await;
        assert!(!approvals.covers("acp-1", "turn-1", "edit").await);
        assert!(!approvals.covers("acp-1", "turn-1", "execute").await);
        assert!(approvals.covers("acp-1", "turn-2", "edit").await, "别的轮不受影响");

        approvals.clear_session("acp-1").await;
        assert!(!approvals.covers("acp-1", "turn-2", "edit").await);
        assert!(approvals.covers("acp-2", "turn-1", "edit").await, "别的连接不受影响");
    }

    #[tokio::test]
    async fn clear_drops_everything_of_a_profile() {
        let pending = PendingRequests::default();
        pending.mark("p1", 1).await;
        pending.mark("p1", 2).await;
        pending.mark("p2", 1).await;

        pending.clear("p1").await;

        // 断连后残留的 id 一律答不出去
        assert!(!pending.take("p1", 1).await);
        assert!(!pending.take("p1", 2).await);
        assert!(pending.take("p2", 1).await);
    }

    #[tokio::test]
    async fn cancel_mark_is_consumed_once() {
        // 一轮只有一个终态：取走即清，否则下一轮会被上一轮的取消标记污染，
        // 把一次真失败误记成「用户取消」。
        let c = Cancels::default();
        assert!(!c.take("s-1").await, "没标记时不该返回 true");

        c.mark("s-1").await;
        assert!(c.take("s-1").await, "标记后第一次取走应为 true");
        assert!(!c.take("s-1").await, "取走之后必须清零");
    }

    #[tokio::test]
    async fn cancel_mark_is_per_session() {
        // 群聊里多个 ACP 会话同时在跑：取消其中一个不能影响另一个
        let c = Cancels::default();
        c.mark("s-1").await;
        assert!(!c.take("s-2").await);
        assert!(c.take("s-1").await);
    }

    #[tokio::test]
    async fn commands_last_write_wins_for_the_same_acp_session() {
        let commands = Commands::default();
        commands
            .put_commands("acp-1", vec![command("old")])
            .await;
        commands
            .put_commands("acp-1", vec![command("new-1"), command("new-2")])
            .await;

        let got = commands.commands_of("acp-1").await;
        assert_eq!(
            got.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            vec!["new-1", "new-2"]
        );
    }

    #[tokio::test]
    async fn commands_are_scoped_per_acp_session() {
        let commands = Commands::default();
        commands.put_commands("acp-1", vec![command("one")]).await;
        commands.put_commands("acp-2", vec![command("two")]).await;

        assert_eq!(commands.commands_of("acp-1").await[0].name, "one");
        assert_eq!(commands.commands_of("acp-2").await[0].name, "two");
    }

    #[tokio::test]
    async fn commands_of_unknown_session_is_empty() {
        let commands = Commands::default();
        assert!(commands.commands_of("never-seen").await.is_empty());
    }

    #[test]
    fn replay_capture_buffers_until_close() {
        let capture = ReplayCapture::default();
        let item = Captured {
            at: 42,
            kind: "tool_call".into(),
            payload_json: r#"{"toolCallId":"c1"}"#.into(),
            refs: None,
            ext: None,
            truncated: false,
        };

        assert!(!capture.push("acp-1", item.clone()), "没开窗口不能捕获");
        capture.open("acp-1");
        assert!(capture.is_open("acp-1"));
        assert!(capture.push("acp-1", item.clone()));

        let got = capture.close("acp-1");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].at, 42);
        assert!(!capture.is_open("acp-1"));
        assert!(!capture.push("acp-1", item), "close 后必须拒收");
    }
}
