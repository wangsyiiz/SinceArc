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

/// 「写」= 会改动磁盘或执行命令。判据只在这里定义，前端不再自行判断。
pub fn is_write_kind(kind: &str) -> bool {
    matches!(kind, "edit" | "execute")
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

/* ---------------- 聚合：从源数据得到「一轮里发生了什么」 ---------------- */

/// 轨迹面板要的一条：一段按 seq 排好的活动。`tool_call` 与它的增量更新已合并。
#[derive(Debug, Clone, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct TraceItem {
    #[ts(type = "number")]
    pub seq: i64,
    #[ts(type = "number")]
    pub at: i64,
    pub author_id: Option<String>,
    pub kind: String,
    #[ts(type = "Record<string, unknown>")]
    pub payload: Value,
    pub truncated: bool,
}

#[derive(Debug, Clone, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct TraceTurn {
    pub id: String,
    pub prompt: String,
    pub author_id: Option<String>,
    #[ts(type = "number")]
    pub started_at: i64,
    #[ts(type = "number | null")]
    pub ended_at: Option<i64>,
    pub status: String,
    pub items: Vec<TraceItem>,
}

/// 把「工具调用的初始事件 + 若干增量更新」合成一条。
///
/// ACP 的 `tool_call_update` 是**增量**：实测（2026-10-22）里 `title`/`locations` 为 null、
/// 只有 `status` 有值。若把 update 当独立条目渲染，轨迹里会出现「terminal: date」加一条
/// 没有标题的 completed —— 看起来像两次操作。
fn merge_tool_call(base: &mut Value, update: &Value) {
    let Some(mut merged) = base.as_object().cloned() else {
        return;
    };
    if let Some(upd) = update.as_object() {
        for (k, v) in upd {
            // 增量为 null 的字段不能覆盖已有值
            if v.is_null() {
                continue;
            }
            // locations 是整体替换语义，但空数组等于「没提到」
            if k == "locations" && v.as_array().is_some_and(|a| a.is_empty()) {
                continue;
            }
            merged.insert(k.clone(), v.clone());
        }
    }
    *base = Value::Object(merged);
}

/// 按轮聚合。事件已在库里按 seq 有序；这里只做「合并 + 排序」，不做任何推断。
pub fn aggregate(turns: Vec<crate::db::TurnRow>, events: Vec<crate::db::EventRow>) -> Vec<TraceTurn> {
    use std::collections::HashMap;

    let mut by_turn: HashMap<String, Vec<crate::db::EventRow>> = HashMap::new();
    for e in events {
        by_turn.entry(e.turn_id.clone()).or_default().push(e);
    }

    turns
        .into_iter()
        .map(|t| {
            let mut rows = by_turn.remove(&t.id).unwrap_or_default();
            rows.sort_by_key(|e| e.seq);

            let mut items: Vec<TraceItem> = Vec::new();
            // toolCallId → items 下标，用于把 update 并回初始事件
            let mut calls: HashMap<String, usize> = HashMap::new();

            for e in rows {
                let payload: Value = serde_json::from_str(&e.payload_json)
                    .unwrap_or_else(|_| json!({ "raw": e.payload_json }));

                // 思考是流式的：hermes 按 token 段发（实测一轮 24 条，"User"、" asks: from now"…
                // 各自成条）。不合并的话轨迹就是 24 行碎片，读不出任何东西。
                if e.kind == "thought" {
                    if let Some(last) = items.last_mut().filter(|i| i.kind == "thought"
                        && i.author_id == e.author_id)
                    {
                        let add = payload.get("text").and_then(Value::as_str).unwrap_or("");
                        let mut text = last
                            .payload
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        text.push_str(add);
                        last.truncated |= e.truncated;
                        if text.len() > THOUGHT_MAX_BYTES {
                            // 合并后仍守 8KB 上限（按字符边界截断，别切坏中文）
                            let (cut, _) = truncate_str(&text, THOUGHT_MAX_BYTES);
                            text = cut;
                            last.truncated = true;
                        }
                        last.payload = json!({ "text": text });
                        continue;
                    }
                }

                if e.kind == "tool_call_update" {
                    if let Some(id) = payload.get("toolCallId").and_then(Value::as_str) {
                        if let Some(&idx) = calls.get(id) {
                            let slot = &mut items[idx];
                            merge_tool_call(&mut slot.payload, &payload);
                            continue;
                        }
                    }
                }
                if e.kind == "tool_call" {
                    if let Some(id) = payload.get("toolCallId").and_then(Value::as_str) {
                        calls.insert(id.to_string(), items.len());
                    }
                }
                items.push(TraceItem {
                    seq: e.seq,
                    at: e.at,
                    author_id: e.author_id,
                    kind: e.kind,
                    payload,
                    truncated: e.truncated,
                });
            }

            TraceTurn {
                id: t.id,
                prompt: t.prompt,
                author_id: t.author_id,
                started_at: t.started_at,
                ended_at: t.ended_at,
                status: t.status,
                items,
            }
        })
        .collect()
}


/// 补上「有事件、没有轮次行」的轮次。
///
/// 正常情况下不会出现：轮次在提问时与 turn id 一起落库。但历史数据（本轮修复之前的那批，
/// 轮次外键拿错 id 写失败了）只有事件 —— 如果直接按 turns 聚合，这些事件就会**静默消失**，
/// 界面显示「没有轨迹」，而库里明明有 28 条。宁可显示「提问没有记录」，也不能让人以为没发生过。
pub fn with_orphan_turns(
    mut turns: Vec<crate::db::TurnRow>,
    session_id: &str,
    events: &[crate::db::EventRow],
) -> Vec<crate::db::TurnRow> {
    use std::collections::HashSet;

    let known: HashSet<&str> = turns.iter().map(|t| t.id.as_str()).collect();
    let mut ranges: std::collections::HashMap<&str, (i64, i64)> = std::collections::HashMap::new();
    for e in events {
        if known.contains(e.turn_id.as_str()) {
            continue;
        }
        let r = ranges.entry(e.turn_id.as_str()).or_insert((e.at, e.at));
        r.0 = r.0.min(e.at);
        r.1 = r.1.max(e.at);
    }
    for (id, (start, end)) in ranges {
        turns.push(crate::db::TurnRow {
            id: id.to_string(),
            session_id: session_id.to_string(),
            prompt: "(这一轮的提问没有记录)".to_string(),
            author_id: None,
            started_at: start,
            ended_at: Some(end),
            status: "unknown".to_string(),
        });
    }
    turns.sort_by_key(|t| std::cmp::Reverse(t.started_at));
    turns
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
    #[test]
    fn 工具调用的增量更新会并回初始事件() {
        use crate::db::{EventRow, TurnRow};
        let turn = TurnRow {
            id: "t1".into(),
            session_id: "s1".into(),
            prompt: "现在几点".into(),
            author_id: None,
            started_at: 1,
            ended_at: Some(9),
            status: "finished".into(),
        };
        let ev = |seq: i64, kind: &str, payload: &str| EventRow {
            id: format!("s1-{seq}"),
            seq,
            at: seq,
            turn_id: "t1".into(),
            author_id: None,
            kind: kind.into(),
            payload_json: payload.into(),
            source: "live".into(),
            truncated: false,
        };
        let events = vec![
            ev(1, "tool_call", r#"{"toolCallId":"c1","title":"terminal: date","kind":"execute","status":null,"locations":[]}"#),
            ev(2, "tool_call_update", r#"{"toolCallId":"c1","title":null,"status":"completed","locations":null}"#),
            ev(3, "thought", r#"{"text":"想一下"}"#),
        ];
        let out = aggregate(vec![turn], events);
        assert_eq!(out.len(), 1);
        let items = &out[0].items;
        assert_eq!(items.len(), 2, "update 必须并回 tool_call，不能多一条");
        assert_eq!(items[0].kind, "tool_call");
        assert_eq!(items[0].payload["status"], "completed", "增量里的 status 要生效");
        assert_eq!(items[0].payload["title"], "terminal: date", "null 不能覆盖已有标题");
        assert_eq!(items[0].payload["locations"], json!([]), "空数组不覆盖");
        assert_eq!(items[1].kind, "thought");
    }


    #[test]
    fn 只有事件没有轮次行时也要显示出来() {
        use crate::db::{EventRow, TurnRow};
        let events = vec![EventRow {
            id: "s1-1".into(),
            seq: 1,
            at: 100,
            turn_id: "turn-x".into(),
            author_id: None,
            kind: "tool_call".into(),
            payload_json: "{}".into(),
            source: "live".into(),
            truncated: false,
        }];
        let out = with_orphan_turns(Vec::<TurnRow>::new(), "s1", &events);
        assert_eq!(out.len(), 1, "有事件就必须有一轮，不能静默丢掉");
        assert_eq!(out[0].id, "turn-x");
        assert_eq!(out[0].status, "unknown");
        assert!(out[0].prompt.contains("没有记录"));
    }


    #[test]
    fn 流式思考会合并成一条() {
        use crate::db::{EventRow, TurnRow};
        let turn = TurnRow {
            id: "t1".into(),
            session_id: "s1".into(),
            prompt: "还有多少小时".into(),
            author_id: None,
            started_at: 1,
            ended_at: Some(9),
            status: "finished".into(),
        };
        let ev = |seq: i64, text: &str| EventRow {
            id: format!("s1-{seq}"),
            seq,
            at: seq,
            turn_id: "t1".into(),
            author_id: None,
            kind: "thought".into(),
            payload_json: json!({ "text": text }).to_string(),
            source: "live".into(),
            truncated: false,
        };
        let events = vec![
            ev(1, "User"),
            ev(2, " asks: 还有几小时"),
            ev(3, "？算一下"),
        ];
        let out = aggregate(vec![turn], events);
        assert_eq!(out[0].items.len(), 1, "思考片段必须合并，否则轨迹是碎片");
        assert_eq!(out[0].items[0].payload["text"], "User asks: 还有几小时？算一下");
        assert_eq!(out[0].items[0].seq, 1, "合并后保留第一段的位置");
    }

}
