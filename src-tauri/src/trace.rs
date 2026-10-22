//! 轨迹采集：把 ACP 的 `session/update` / 权限请求解析成可落库的事件。
//!
//! 为什么在这里解析而不是在界面里：轨迹是**用户的历史**（重启后要能溯源、群里要能分辨
//! 谁做了什么），而界面生命周期比它短。协议细节只在这一个模块里认识，
//! 上层拿到的是 `Captured { kind, payload }`。
//!
//! 截断规则（所有者拍板，见 `docs/ipc-contract.md` §7）：
//! - 思考正文只保留前 8KB，并标记 `truncated`（界面要写明，别让用户以为是 bug）；
//! - 任何单条事件序列化后不超过 64KB。

use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

/// 毫秒时间戳（轨迹与 turn id 都用它，避免多一处时间来源）。
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 思考正文上限：够看出「它在往哪个方向想」，不追求逐字复现。
pub const THOUGHT_MAX_BYTES: usize = 8 * 1024;
/// 单条事件上限：超过就截断并标记。
pub const PAYLOAD_MAX_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct Captured {
    pub kind: &'static str,
    pub payload: Value,
    pub truncated: bool,
}

fn text_of(update: &Value) -> Option<String> {
    update
        .get("content")
        .and_then(|c| c.get("text"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            // 有些 agent 把正文放在 content 数组里：[{type:"text",text:"…"}]
            update
                .get("content")
                .and_then(Value::as_array)
                .and_then(|arr| {
                    let parts: Vec<&str> = arr
                        .iter()
                        .filter_map(|c| c.get("text").and_then(Value::as_str))
                        .collect();
                    if parts.is_empty() {
                        None
                    } else {
                        Some(parts.join(""))
                    }
                })
        })
}

/// 按**字符边界**截断，不切坏多字节字符。
fn truncate_str(s: &str, max_bytes: usize) -> (String, bool) {
    if s.len() <= max_bytes {
        return (s.to_string(), false);
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    (s[..end].to_string(), true)
}

/// 把一条入站消息解析成轨迹事件。不是轨迹类消息就返回 None（普通回答 chunk 不进轨迹）。
pub fn parse(method: &str, params: &Value) -> Option<Captured> {
    match method {
        "session/request_permission" => {
            let tool = params.get("toolCall").cloned().unwrap_or(Value::Null);
            let options: Vec<Value> = params
                .get("options")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .map(|o| {
                            json!({
                                "kind": o.get("kind").and_then(Value::as_str),
                                "optionId": o.get("optionId").and_then(Value::as_str),
                                "name": o.get("name").and_then(Value::as_str),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(Captured {
                kind: "permission",
                payload: json!({
                    "toolCall": {
                        "toolCallId": tool.get("toolCallId").and_then(Value::as_str),
                        "title": tool.get("title").and_then(Value::as_str),
                        "kind": tool.get("kind").and_then(Value::as_str),
                    },
                    "options": options,
                }),
                truncated: false,
            })
        }
        "session/update" => {
            let update = params.get("update")?;
            let kind = update.get("sessionUpdate").and_then(Value::as_str)?;
            match kind {
                "agent_thought_chunk" => {
                    let raw = text_of(update).unwrap_or_default();
                    let (text, truncated) = truncate_str(&raw, THOUGHT_MAX_BYTES);
                    Some(Captured {
                        kind: "thought",
                        payload: json!({ "text": text, "bytes": raw.len() }),
                        truncated,
                    })
                }
                "tool_call" | "tool_call_update" => {
                    // 工具调用要结构化保存：界面靠 kind/路径/状态判断「谁在写」，
                    // 只存描述文本就推不出来（E6 的写锁要靠这些字段）。
                    let payload = json!({
                        "toolCallId": update.get("toolCallId").and_then(Value::as_str),
                        "title": update.get("title").and_then(Value::as_str),
                        "kind": update.get("kind").and_then(Value::as_str),
                        "status": update.get("status").and_then(Value::as_str),
                        "locations": update.get("locations").cloned().unwrap_or(Value::Null),
                    });
                    let (payload, truncated) = cap_payload(payload);
                    Some(Captured {
                        kind: if kind == "tool_call" { "tool_call" } else { "tool_call_update" },
                        payload,
                        truncated,
                    })
                }
                "current_mode_update" => Some(Captured {
                    kind: "mode",
                    payload: json!({
                        "currentModeId": update.get("currentModeId").and_then(Value::as_str),
                    }),
                    truncated: false,
                }),
                "usage_update" => Some(Captured {
                    kind: "usage",
                    payload: update.clone(),
                    truncated: false,
                }),
                // agent_message_chunk / user_message_chunk 是对话正文，走 messages，不进轨迹
                _ => None,
            }
        }
        _ => None,
    }
}

fn cap_payload(payload: Value) -> (Value, bool) {
    let size = serde_json::to_string(&payload).map(|s| s.len()).unwrap_or(0);
    if size <= PAYLOAD_MAX_BYTES {
        (payload, false)
    } else {
        (json!({ "truncated": true, "bytes": size }), true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 思考超限只留前八_kb_并标记() {
        let long = "思".repeat(5000); // 5k 个汉字 = 15KB
        let params = json!({
            "sessionId": "s1",
            "update": { "sessionUpdate": "agent_thought_chunk", "content": { "type": "text", "text": long } }
        });
        let cap = parse("session/update", &params).expect("thought");
        assert_eq!(cap.kind, "thought");
        assert!(cap.truncated, "超过 8KB 必须标记");
        let text = cap.payload["text"].as_str().unwrap();
        assert!(text.len() <= THOUGHT_MAX_BYTES);
        assert!(text.chars().all(|c| c == '思'), "不能切坏多字节字符");
    }

    #[test]
    fn 工具调用保留结构化字段() {
        let params = json!({
            "update": {
                "sessionUpdate": "tool_call", "toolCallId": "t1", "title": "写入文件",
                "kind": "edit", "status": "pending",
                "locations": [{ "path": "/tmp/a.txt" }]
            }
        });
        let cap = parse("session/update", &params).expect("tool");
        assert_eq!(cap.kind, "tool_call");
        assert_eq!(cap.payload["toolCallId"], "t1");
        assert_eq!(cap.payload["kind"], "edit");
        assert!(!cap.truncated);
    }

    #[test]
    fn 权限请求解析出标题与选项() {
        let params = json!({
            "toolCall": { "toolCallId": "t1", "title": "执行 rm -rf", "kind": "execute" },
            "options": [
                { "kind": "allow_once", "optionId": "allow_once", "name": "允许一次" },
                { "kind": "reject_once", "optionId": "deny", "name": "拒绝" }
            ]
        });
        let cap = parse("session/request_permission", &params).expect("perm");
        assert_eq!(cap.kind, "permission");
        assert_eq!(cap.payload["toolCall"]["title"], "执行 rm -rf");
        assert_eq!(cap.payload["options"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn 回答正文不进轨迹() {
        let params = json!({
            "update": { "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "你好" } }
        });
        assert!(parse("session/update", &params).is_none());
    }
}
