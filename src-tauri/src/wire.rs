//! 单一事件通道 + 信封（`docs/ipc-contract.md` §3–4）。
//!
//! 以前是「每个连接一条 `Channel<AcpEvent>`」：连 3 个 agent 就有 3 条通道，
//! 前端要分别订阅、分别解包，事件也没有顺序号。现在只有一条通道，
//! 所有域的事件都套信封，按 `topic` 路由；`seq` 单调递增，前端能发现丢事件。
//!
//! M1 阶段的目标是**行为不变**：`payload` 里暂时仍是原来的 `AcpEvent`，
//! 等 M2/M3 再把各域的载荷拆细。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::ipc::Channel;

/// 信封版本。破坏性改字段时 +1（前端据此拒绝不认识的版本）。
const WIRE_VERSION: u8 = 1;

/// 一条出站事件的归属信息。缺 `ui_session_id` 就是「不属于任何界面会话」，
/// 前端应当丢弃而不是猜（INV-1）。
#[derive(Debug, Default, Clone)]
pub struct Meta {
    pub profile_id: Option<String>,
    pub session_id: Option<String>,
    pub ui_session_id: Option<String>,
    pub author_id: Option<String>,
}

impl Meta {
    pub fn for_session(
        profile_id: impl Into<String>,
        session_id: impl Into<String>,
        ui_session_id: Option<String>,
        author_id: Option<String>,
    ) -> Self {
        Self {
            profile_id: Some(profile_id.into()),
            session_id: Some(session_id.into()),
            ui_session_id,
            author_id,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireEvent {
    pub v: u8,
    pub seq: u64,
    pub ts: i64,
    pub topic: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ui_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author_id: Option<String>,
    /// 拥塞时是否可以丢弃。终态事件（prompt result/failed）必须为 true。
    pub lossless: bool,
    pub payload: serde_json::Value,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 全局事件总线。一个应用只有一个，不随连接数增长。
#[derive(Default)]
pub struct EventBus {
    seq: AtomicU64,
    /// 前端还没订阅时事件直接丢弃（并计数），不缓存 ——
    /// 缓存会让「重新打开窗口」收到一堆过期事件，归属还可能已经失效。
    sink: Mutex<Option<Channel<WireEvent>>>,
    dropped: AtomicU64,
}

impl EventBus {
    pub fn subscribe(&self, channel: Channel<WireEvent>) {
        *self.sink.lock().expect("bus poisoned") = Some(channel);
    }

    pub fn subscribed(&self) -> bool {
        self.sink.lock().expect("bus poisoned").is_some()
    }

    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    /// 发一条事件。`payload` 由调用方给出，序列化失败就丢（并记日志）——
    /// 事件不该因为一个字段序列化不了就整条崩掉。
    pub fn emit(&self, topic: &str, lossless: bool, meta: Meta, payload: serde_json::Value) -> bool {
        let guard = self.sink.lock().expect("bus poisoned");
        let Some(channel) = guard.as_ref() else {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return false;
        };
        let seq = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        let event = WireEvent {
            v: WIRE_VERSION,
            seq,
            ts: now_ms(),
            topic: topic.to_string(),
            profile_id: meta.profile_id,
            session_id: meta.session_id,
            ui_session_id: meta.ui_session_id,
            author_id: meta.author_id,
            lossless,
            payload,
        };
        channel.send(event).is_ok()
    }

    /// 便捷版：任意可序列化的载荷。
    pub fn emit_json<T: Serialize>(&self, topic: &str, lossless: bool, meta: Meta, payload: &T) -> bool {
        match serde_json::to_value(payload) {
            Ok(v) => self.emit(topic, lossless, meta, v),
            Err(e) => {
                tracing::warn!(target: "sincearc::ipc", topic, error = %e, "事件序列化失败，已丢弃");
                false
            }
        }
    }
}
