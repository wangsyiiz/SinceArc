//! 运行时状态：活着的 agent 进程。
//!
//! 只放「进程 + 握手结果」。会话、消息、权限请求属于会话层（E2 起），不放这里 ——
//! 一个 profile 可以连多个 session，两者的生命周期不同。

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::acp::launch::AgentProfile;
use crate::acp::{transport, InitializeOutcome, SessionModes};

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
    /// 配置与会话记账（同步 SQLite，操作都是毫秒级，直接锁用）
    pub db: Arc<crate::db::Db>,
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
}

#[derive(Clone, Default)]
pub struct PendingRequests(Arc<Mutex<HashMap<String, HashSet<u64>>>>);

impl PendingRequests {
    pub async fn mark(&self, profile_id: &str, id: u64) {
        self.0
            .lock()
            .await
            .entry(profile_id.to_string())
            .or_default()
            .insert(id);
    }

    /// 取出并移除。返回 false = 这个 id 不在册（已被回答过，或本来就不是我们发的）。
    pub async fn take(&self, profile_id: &str, id: u64) -> bool {
        let mut map = self.0.lock().await;
        map.get_mut(profile_id)
            .map(|set| set.remove(&id))
            .unwrap_or(false)
    }

    pub async fn clear(&self, profile_id: &str) {
        self.0.lock().await.remove(profile_id);
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
            db: Arc::new(db),
        }
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
    use super::{PendingRequests, Routes, SessionRecord};

    fn rec(ui: Option<&str>, author: Option<&str>) -> SessionRecord {
        SessionRecord {
            profile_id: "p1".into(),
            cwd: "/tmp".into(),
            ui_session_id: ui.map(str::to_string),
            author_id: author.map(str::to_string),
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
}
