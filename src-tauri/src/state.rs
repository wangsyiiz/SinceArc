//! 运行时状态：活着的 agent 进程。
//!
//! 只放「进程 + 握手结果」。会话、消息、权限请求属于会话层（E2 起），不放这里 ——
//! 一个 profile 可以连多个 session，两者的生命周期不同。

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::acp::launch::AgentProfile;
use crate::acp::{transport, InitializeOutcome, SessionModes};
use crate::commands::AcpEvent;

pub struct AgentHandle {
    pub proc: Arc<transport::AgentProcess>,
    pub outcome: InitializeOutcome,
    /// 起进程时用的 profile（cwd、launch 方式），session 创建要用
    pub profile: AgentProfile,
    /// 推给界面的事件通道。prompt 是长请求，响应从后台 task 回来，
    /// 所以句柄要自己持有一份。
    pub events: tauri::ipc::Channel<AcpEvent>,
}

/// 一个 ACP 会话属于哪个 profile（后续 prompt / cancel 要按它路由）
#[derive(Debug, Clone)]
pub struct SessionRecord {
    pub profile_id: String,
    pub cwd: String,
}

pub struct AppState {
    agents: Mutex<HashMap<String, Arc<AgentHandle>>>,
    sessions: Mutex<HashMap<String, SessionRecord>>,
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
            agents: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
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
    use super::PendingRequests;

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
