//! ACP 接入层。
//!
//! 设计约束（见 docs/acp-notes.md）：
//! 1. 所有协议类型只出现在本模块内 —— UI 只消费 `AcpEvent` 自己的枚举。
//! 2. 进程由我们自己起（tokio::process），不用 crate 的 `process` feature：
//!    WSL 场景中间隔着 `wsl.exe` relay，需要 setsid + 自己记 pid 才能干净杀掉。
//! 3. 协议版本显式钉 v1；`unstable_protocol_v2` 不启用。

pub mod discover;
pub mod launch;
pub mod transport;

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use launch::AgentProfile;

/// `initialize` 的结果：只保留 UI 真正要用的那几项。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InitializeOutcome {
    pub protocol_version: i64,
    pub agent_name: String,
    pub agent_version: String,
    pub load_session: bool,
    pub image_prompts: bool,
    pub auth_methods: Vec<String>,
    /// 握手报上来的协议能力，归一成一组稳定的键（见 `capability_keys`）。
    /// 界面上「这个 agent 能做什么」应该来自这里，而不是按 agent 名硬编码一张表。
    pub capabilities: Vec<String>,
}

impl InitializeOutcome {
    fn from_result(result: &Value) -> Self {
        let caps = result.get("agentCapabilities");
        let info = result.get("agentInfo");
        let auth = result
            .get("authMethods")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|m| m.get("id").and_then(Value::as_str).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();

        Self {
            protocol_version: result
                .get("protocolVersion")
                .and_then(Value::as_i64)
                .unwrap_or(0),
            agent_name: info
                .and_then(|i| i.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string(),
            agent_version: info
                .and_then(|i| i.get("version"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            load_session: caps
                .and_then(|c| c.get("loadSession"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
            image_prompts: caps
                .and_then(|c| c.get("promptCapabilities"))
                .and_then(|p| p.get("image"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
            auth_methods: auth,
            capabilities: capability_keys(caps),
        }
    }
}

/// 把 `agentCapabilities` 里「有就是 true」的字段摊平成键列表。
///
/// 只认协议里定义的字段；不认识的忽略 —— 猜一个能力出来比不显示更糟。
fn capability_keys(caps: Option<&Value>) -> Vec<String> {
    let Some(caps) = caps else { return Vec::new() };
    let mut out = Vec::new();
    let flag = |path: &[&str]| {
        let mut cur = caps;
        for key in path {
            match cur.get(*key) {
                Some(next) => cur = next,
                None => return false,
            }
        }
        cur.as_bool().unwrap_or(false)
    };
    if flag(&["loadSession"]) {
        out.push("loadSession".to_string());
    }
    for (key, path) in [
        ("image", &["promptCapabilities", "image"][..]),
        ("audio", &["promptCapabilities", "audio"][..]),
        (
            "embeddedContext",
            &["promptCapabilities", "embeddedContext"][..],
        ),
    ] {
        if flag(path) {
            out.push(key.to_string());
        }
    }
    // 会话级能力：有的实现是 `{}`（存在即支持），有的是 true
    if let Some(sessions) = caps.get("sessionCapabilities") {
        for key in ["fork", "list", "resume", "delete"] {
            if let Some(v) = sessions.get(key) {
                if v.as_bool().unwrap_or(true) {
                    out.push(key.to_string());
                }
            }
        }
    }
    if caps.get("mcp").is_some() {
        out.push("mcp".to_string());
    }
    out
}

/// agent 报上来的一个可选模式。只留 UI 要展示的字段。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeOption {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
}

/// 打开会话时的模式快照：`available` 用于校验目标值，`current` 是 agent 当时的生效值。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionModes {
    pub available: Vec<ModeOption>,
    pub current: String,
}

/// 从 session/new、session/load 的响应里取 modes。
/// 规范 §2 要求将来 configOptions(category=="mode") 优先，但 hermes 现阶段只下发
/// modes（configOptions 为空），所以先只解析 modes，留一条 TODO 注明升级点。
pub fn modes_from_response(v: &Value) -> Option<SessionModes> {
    // TODO: configOptions(category=="mode") 出现后，这里要先解析它，缺失再回落到 modes。
    let modes = v.get("modes")?;
    let raw = modes.get("availableModes")?.as_array()?;
    if raw.is_empty() {
        return None;
    }

    let available: Vec<ModeOption> = raw
        .iter()
        .filter_map(|m| {
            let id = m.get("id")?.as_str()?.to_string();
            let name = m.get("name")?.as_str()?.to_string();
            // 可缺省；但显式给了非字符串值说明这一项不可信，整项跳过。
            let description = match m.get("description") {
                None | Some(Value::Null) => None,
                Some(Value::String(s)) => Some(s.clone()),
                Some(_) => return None,
            };
            Some(ModeOption {
                id,
                name,
                description,
            })
        })
        .collect();

    if available.is_empty() {
        return None;
    }

    let current = modes
        .get("currentModeId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| available[0].id.clone());

    Some(SessionModes { available, current })
}

#[cfg(test)]
mod modes_tests {
    use super::modes_from_response;
    use serde_json::json;

    /// 真实返回（2026-10-21 实测 hermes-agent 0.22.2）裁成三档
    #[test]
    fn parses_real_shape() {
        let v = json!({
            "sessionId": "local-abc",
            "modes": {
                "currentModeId": "default",
                "availableModes": [
                    { "id": "default", "name": "Default", "description": "Ask before edits." },
                    { "id": "accept_edits", "name": "Accept Edits", "description": "Auto-allow workspace and temp-dir edits; still asks for sensitive paths." },
                    { "id": "dont_ask", "name": "Don't Ask", "description": "Auto-allow file edits for this session except sensitive paths." }
                ]
            }
        });
        let m = modes_from_response(&v).expect("应当解析出来");
        assert_eq!(m.current, "default");
        assert_eq!(m.available.len(), 3);
        assert_eq!(m.available[2].id, "dont_ask");
    }

    /// 没有 modes / 空列表 → None：上层据此「不推」（规范 §4 兜底）
    #[test]
    fn absent_or_empty_gives_none() {
        assert!(modes_from_response(&json!({ "sessionId": "s" })).is_none());
        assert!(modes_from_response(&json!({ "modes": { "availableModes": [] } })).is_none());
        assert!(modes_from_response(&json!({ "modes": {} })).is_none());
    }

    /// 缺 currentModeId 时用第一档兜底，不要 panic
    #[test]
    fn current_falls_back_to_first() {
        let v = json!({ "modes": { "availableModes": [{ "id": "ask", "name": "Ask" }] } });
        let m = modes_from_response(&v).expect("应当解析出来");
        assert_eq!(m.current, "ask");
        assert!(m.available[0].description.is_none());
    }

    /// 单条坏数据只跳过自己，不影响整份快照
    #[test]
    fn bad_entry_is_skipped_not_fatal() {
        let v = json!({ "modes": { "currentModeId": "b", "availableModes": [
            { "id": "a", "name": "A", "description": 42 },
            { "name": "缺 id" },
            { "id": "b", "name": "B" }
        ]}});
        let m = modes_from_response(&v).expect("应当解析出来");
        assert_eq!(m.available.len(), 1);
        assert_eq!(m.available[0].id, "b");
    }
}

/// 起进程并完成握手。返回会话外壳与 outcome。
///
/// 注意：调用方必须持续消费返回的 `incoming`，否则 reader task 会在 channel 满时阻塞。
pub async fn initialize(
    profile: &AgentProfile,
    cwd: &str,
    timeout: Duration,
) -> Result<
    (
        transport::AgentProcess,
        tokio::sync::mpsc::Receiver<transport::Incoming>,
        InitializeOutcome,
    ),
    transport::TransportError,
> {
    let (proc, incoming, mut stderr) = transport::spawn(profile, cwd)?;

    // stderr 只留最后 40 行，用于失败时给出 agent 的抱怨
    let stderr_tail = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let tail = stderr_tail.clone();
    tokio::spawn(async move {
        while let Some(line) = stderr.recv().await {
            let mut buf = tail.lock().expect("stderr tail poisoned");
            if buf.len() >= 40 {
                buf.remove(0);
            }
            buf.push(line);
        }
    });

    let params = serde_json::json!({
        "protocolVersion": 1,
        // 能力要照实报：`fs/*` 和 `terminal/*` 我们一行实现都没有。报 true 等于请 agent
        // 把文件读写和终端执行甩给客户端，然后它去等一个永远不会来的响应 —— 表现是
        // 整轮 prompt 卡住直到超时，而且看起来像 agent 的问题。
        "clientCapabilities": {
            "fs": { "readTextFile": false, "writeTextFile": false },
            "terminal": false
        }
    });

    match proc.request("initialize", params, timeout).await {
        Ok(result) => {
            if result.get("protocolVersion").and_then(Value::as_i64) != Some(1) {
                tracing::warn!(target: "sincearc::acp", "agent negotiated an unexpected protocol version");
            }
            Ok((proc, incoming, InitializeOutcome::from_result(&result)))
        }
        Err(e) => {
            // 睡一会儿让 stderr 的 reader 把崩溃前的输出收进来
            tokio::time::sleep(Duration::from_millis(150)).await;
            let tail = stderr_tail.lock().expect("stderr tail poisoned").clone();
            if !tail.is_empty() {
                tracing::error!(target: "sincearc::acp", "agent stderr tail:\n{}", tail.join("\n"));
            }
            Err(transport::TransportError::Handshake {
                reason: e.to_string(),
                stderr_tail: tail,
            })
        }
    }
}

/// 给前端的能力探测占位：E1 之后改成真结果。
#[tauri::command]
pub fn list_profiles_hint() -> Vec<&'static str> {
    vec!["wsl:hermes acp", "local:mock"]
}
