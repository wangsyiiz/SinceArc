//! 运行时状态：活着的 agent 进程。
//!
//! 只放「进程 + 握手结果」。会话、消息、权限请求属于会话层（E2 起），不放这里 ——
//! 一个 profile 可以连多个 session，两者的生命周期不同。

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::acp::launch::AgentProfile;
use crate::acp::{transport, InitializeOutcome};

pub struct AgentHandle {
    pub proc: Arc<transport::AgentProcess>,
    pub outcome: InitializeOutcome,
    /// 起进程时用的 profile（cwd、launch 方式），session 创建要用
    pub profile: AgentProfile,
}

#[derive(Default)]
pub struct AppState {
    agents: Mutex<HashMap<String, Arc<AgentHandle>>>,
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
}
