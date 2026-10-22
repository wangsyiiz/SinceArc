//! 写操作提示锁：只描述「当前有哪些写操作在跑」，不参与调度或禁用发送。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::trace::{is_write_kind, now_ms};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockEntry {
    pub author_id: Option<String>,
    pub title: String,
    pub kind: String,
    pub since: i64,
}

/// 某一时刻的锁状态。多个写操作并存时，`held_by` 取最近开始的那个，`count` 是总数。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockState {
    pub held_by: Option<LockEntry>,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct SessionLockDto {
    /// 哪个 ACP 会话在写：群聊里每个成员是独立 ACP 会话，
    /// 前端必须按它分别记账，否则一个成员解锁会把另一个的提示清掉。
    pub acp_session_id: String,
    pub ui_session_id: Option<String>,
    pub player_id: Option<String>,
    pub title: String,
    pub since: i64,
    pub count: usize,
}

impl SessionLockDto {
    pub fn from_state(state: &LockState, acp_session_id: String, ui_session_id: Option<String>) -> Self {
        let held = state.held_by.as_ref();
        Self {
            acp_session_id,
            ui_session_id,
            player_id: held.and_then(|e| e.author_id.clone()),
            title: held.map(|e| e.title.clone()).unwrap_or_default(),
            since: held.map(|e| e.since).unwrap_or(0),
            count: state.count,
        }
    }

    pub fn unlocked(acp_session_id: String, ui_session_id: Option<String>) -> Self {
        Self {
            acp_session_id,
            ui_session_id,
            player_id: None,
            title: String::new(),
            since: 0,
            count: 0,
        }
    }
}

#[derive(Debug)]
struct StoredLock {
    entry: LockEntry,
    order: u64,
}

#[derive(Default)]
struct SessionLocks {
    calls: HashMap<String, StoredLock>,
    next_order: u64,
}

/// ACP 会话 id → (toolCallId → LockEntry)。克隆只复制共享句柄。
#[derive(Clone, Default)]
pub struct WriteLocks {
    inner: Arc<Mutex<HashMap<String, SessionLocks>>>,
}

impl WriteLocks {
    /// 收到一条 `session/update` 通知后调用。
    /// 返回 `Some(state)` 表示状态变了（调用方据此推送），`None` 表示无关或没变。
    pub fn update(&self, acp_sid: &str, params: &serde_json::Value) -> Option<LockState> {
        let update = params.get("update")?;
        let session_update = update
            .get("sessionUpdate")
            .and_then(serde_json::Value::as_str)?;
        let tool_call_id = update
            .get("toolCallId")
            .and_then(serde_json::Value::as_str)?
            .to_string();

        let proposed = match session_update {
            "tool_call" => {
                let kind = update
                    .get("kind")
                    .and_then(serde_json::Value::as_str)?;
                if !is_write_kind(kind) {
                    return None;
                }
                let title = update
                    .get("title")
                    .and_then(serde_json::Value::as_str)
                    .filter(|s| !s.is_empty())
                    .unwrap_or("写入中")
                    .to_string();
                let author_id = params
                    .get("authorId")
                    .or_else(|| update.get("authorId"))
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string);
                Some(LockEntry {
                    author_id,
                    title,
                    kind: kind.to_string(),
                    since: now_ms(),
                })
            }
            "tool_call_update" => {
                let status = update
                    .get("status")
                    .and_then(serde_json::Value::as_str);
                if !matches!(status, Some("completed" | "failed")) {
                    return None;
                }
                None
            }
            _ => return None,
        };

        let mut guard = self.inner.lock().expect("write locks poisoned");
        let (before, after) = {
            let session = guard.entry(acp_sid.to_string()).or_default();
            let before = snapshot(session);
            let changed = match proposed {
                Some(entry) => {
                    let unchanged = session
                        .calls
                        .get(&tool_call_id)
                        .is_some_and(|stored| stored.entry == entry);
                    if !unchanged {
                        let order = session.next_order;
                        session.next_order = session.next_order.saturating_add(1);
                        session
                            .calls
                            .insert(tool_call_id, StoredLock { entry, order });
                    }
                    !unchanged
                }
                None => session.calls.remove(&tool_call_id).is_some(),
            };
            if !changed {
                return None;
            }
            (before, snapshot(session))
        };

        if after == before {
            return None;
        }
        if after.count == 0 {
            guard.remove(acp_sid);
        }
        Some(after)
    }

    /// 一轮结束（promptResult / promptFailed / 取消）时清空该会话。
    pub fn clear(&self, acp_sid: &str) -> Option<LockState> {
        let mut guard = self.inner.lock().expect("write locks poisoned");
        guard.remove(acp_sid).map(|_| LockState {
            held_by: None,
            count: 0,
        })
    }
}

fn snapshot(session: &SessionLocks) -> LockState {
    LockState {
        held_by: session
            .calls
            .values()
            .max_by_key(|stored| stored.order)
            .map(|stored| stored.entry.clone()),
        count: session.calls.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(id: &str, author: &str, kind: &str, title: &str) -> serde_json::Value {
        serde_json::json!({
            "authorId": author,
            "update": {
                "sessionUpdate": "tool_call",
                "toolCallId": id,
                "kind": kind,
                "title": title,
            }
        })
    }

    fn done(id: &str, status: &str) -> serde_json::Value {
        serde_json::json!({
            "update": {
                "sessionUpdate": "tool_call_update",
                "toolCallId": id,
                "status": status,
            }
        })
    }

    #[test]
    fn write_tool_call_locks() {
        let locks = WriteLocks::default();
        let state = locks
            .update("acp-1", &call("t1", "u1", "edit", "改文件"))
            .expect("write should lock");
        assert_eq!(state.count, 1);
        assert_eq!(state.held_by.as_ref().map(|e| e.title.as_str()), Some("改文件"));
    }

    #[test]
    fn read_tool_call_does_not_lock() {
        let locks = WriteLocks::default();
        assert!(locks
            .update("acp-1", &call("t1", "u1", "read", "读文件"))
            .is_none());
    }

    #[test]
    fn completed_update_unlocks() {
        let locks = WriteLocks::default();
        assert!(locks
            .update("acp-1", &call("t1", "u1", "edit", "改文件"))
            .is_some());
        let state = locks
            .update("acp-1", &done("t1", "completed"))
            .expect("completion should unlock");
        assert_eq!(state, LockState { held_by: None, count: 0 });
    }

    #[test]
    fn two_writers_keep_newest_and_count() {
        let locks = WriteLocks::default();
        locks
            .update("acp-1", &call("t1", "a", "edit", "甲在写"))
            .expect("first lock");
        let state = locks
            .update("acp-1", &call("t2", "b", "execute", "乙在跑"))
            .expect("second lock");
        assert_eq!(state.count, 2);
        assert_eq!(state.held_by.and_then(|e| e.author_id).as_deref(), Some("b"));
    }

    #[test]
    fn clear_drops_everything() {
        let locks = WriteLocks::default();
        locks
            .update("acp-1", &call("t1", "u1", "edit", "改文件"))
            .expect("lock");
        let state = locks.clear("acp-1").expect("clear should report unlock");
        assert_eq!(state, LockState { held_by: None, count: 0 });
    }

    #[test]
    fn irrelevant_updates_return_none() {
        let locks = WriteLocks::default();
        for params in [
            serde_json::json!({"update": {"sessionUpdate": "agent_thought_chunk", "content": {"text": "想"}}}),
            serde_json::json!({"update": {"sessionUpdate": "usage_update", "used": 1}}),
            serde_json::json!({"update": {"sessionUpdate": "current_mode_update", "currentModeId": "x"}}),
        ] {
            assert!(locks.update("acp-1", &params).is_none());
        }
    }
}
