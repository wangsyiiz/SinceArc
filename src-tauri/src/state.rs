//! 运行时状态：活着的 agent 进程。
//!
//! 只放「进程 + 握手结果」。会话、消息、权限请求属于会话层（E2 起），不放这里 ——
//! 一个 profile 可以连多个 session，两者的生命周期不同。

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

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
    use std::sync::Arc;

    use tokio::sync::Notify;

    use super::{
        Cancels, CommandDto, Commands, ContextMode, ContextReason, DelegateEntry, DelegateStatus,
        Delegates, PendingRequests, Routes, SessionRecord,
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
}
