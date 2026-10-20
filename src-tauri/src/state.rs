//! 运行时状态：活着的 agent 进程。
//!
//! 只放「进程 + 握手结果」。会话、消息、权限请求属于会话层（E2 起），不放这里 ——
//! 一个 profile 可以连多个 session，两者的生命周期不同。

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::acp::launch::AgentProfile;
use crate::acp::{transport, InitializeOutcome};
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

#[derive(Default)]
pub struct AppState {
    agents: Mutex<HashMap<String, Arc<AgentHandle>>>,
    sessions: Mutex<HashMap<String, SessionRecord>>,
}

impl AppState {
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

    /// 断连时把该 profile 名下的会话一并摘掉（进程没了，会话不可能还活着）
    pub async fn drop_sessions_of(&self, profile_id: &str) -> Vec<String> {
        let mut map = self.sessions.lock().await;
        let dead: Vec<String> = map
            .iter()
            .filter(|(_, r)| r.profile_id == profile_id)
            .map(|(k, _)| k.clone())
            .collect();
        for k in &dead {
            map.remove(k);
        }
        dead
    }
}
