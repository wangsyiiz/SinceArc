//! ACP 接入层。
//!
//! 设计约束（见 docs/acp-notes.md）：
//! 1. 所有协议类型只出现在本模块内 —— UI 只消费 `AcpEvent` 自己的枚举。
//! 2. 进程由我们自己起（tokio::process），不用 crate 的 `process` feature：
//!    WSL 场景中间隔着 `wsl.exe` relay，需要 setsid + 自己记 pid 才能干净杀掉。
//! 3. 协议版本显式钉 v1；`unstable_protocol_v2` 不启用。

pub mod discover;
pub mod fs;
pub mod launch;
pub mod transport;

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use launch::AgentProfile;

/// `initialize` 的 `agentCapabilities` 归一化结果。
///
/// 只认协议里定义的字段；不认识的键忽略 —— 猜一个能力出来比不显示更糟。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct AgentCaps {
    pub load_session: bool,
    pub prompt_image: bool,
    pub prompt_audio: bool,
    pub prompt_embedded_context: bool,
    pub session_list: bool,
    pub session_delete: bool,
    pub session_fork: bool,
    pub session_resume: bool,
    pub session_close: bool,
    pub mcp_http: bool,
    pub mcp_sse: bool,
    pub mcp_acp: bool,
}

fn flag(value: Option<&Value>) -> bool {
    value.and_then(Value::as_bool).unwrap_or(false)
}

/// 会话族 / MCP 族的字段是 `Option<对象>`：`{}` 与 `true` 都表示「支持」，
/// 只有 `null`、缺失或明确的 `false` 表示不支持。
fn appears(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(_) => true,
    }
}

/// 从 `agentCapabilities` 解析能力矩阵。
///
/// 布尔字段直读；会话族与 MCP 族的字段按「出现过」判断。
pub fn parse_agent_caps(caps: Option<&Value>) -> AgentCaps {
    let prompt = caps.and_then(|c| c.get("promptCapabilities"));
    let session = caps.and_then(|c| c.get("sessionCapabilities"));
    let mcp = caps.and_then(|c| c.get("mcpCapabilities"));

    AgentCaps {
        load_session: flag(caps.and_then(|c| c.get("loadSession"))),
        prompt_image: flag(prompt.and_then(|p| p.get("image"))),
        prompt_audio: flag(prompt.and_then(|p| p.get("audio"))),
        prompt_embedded_context: flag(prompt.and_then(|p| p.get("embeddedContext"))),
        session_list: appears(session.and_then(|s| s.get("list"))),
        session_delete: appears(session.and_then(|s| s.get("delete"))),
        session_fork: appears(session.and_then(|s| s.get("fork"))),
        session_resume: appears(session.and_then(|s| s.get("resume"))),
        session_close: appears(session.and_then(|s| s.get("close"))),
        mcp_http: appears(mcp.and_then(|m| m.get("http"))),
        mcp_sse: appears(mcp.and_then(|m| m.get("sse"))),
        mcp_acp: appears(mcp.and_then(|m| m.get("acp"))),
    }
}

/// `initialize` 的结果：只保留 UI 真正要用的那几项。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InitializeOutcome {
    pub protocol_version: i64,
    pub agent_name: String,
    pub agent_version: String,
    pub load_session: bool,
    pub auth_methods: Vec<String>,
    /// 握手报上来的协议能力。
    /// 界面上「这个 agent 能做什么」应该来自这里，而不是按 agent 名硬编码一张表。
    pub caps: AgentCaps,
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
            auth_methods: auth,
            caps: parse_agent_caps(caps),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::parse_agent_caps;
    use serde_json::json;

    /// 真机 hermes（2026-10-24）的 `agentCapabilities` 原文。
    #[test]
    fn parses_real_hermes_capabilities() {
        let caps = json!({
            "loadSession": true,
            "promptCapabilities": { "image": true },
            "sessionCapabilities": { "fork": {}, "list": {}, "resume": {} }
        });
        let c = parse_agent_caps(Some(&caps));
        assert!(c.load_session);
        assert!(c.prompt_image);
        assert!(c.session_fork);
        assert!(c.session_list);
        assert!(c.session_resume);
        assert!(!c.prompt_audio);
        assert!(!c.prompt_embedded_context);
        assert!(!c.session_delete);
        assert!(!c.session_close);
        assert!(!c.mcp_http);
        assert!(!c.mcp_sse);
        assert!(!c.mcp_acp);
    }

    /// 会话族的 `{}` 与 `true` 同义；`null` 与缺失同为不支持。
    #[test]
    fn session_capabilities_presence_is_enough() {
        let caps = json!({
            "sessionCapabilities": {
                "fork": {},
                "list": true,
                "resume": {},
                "delete": null
            }
        });
        let c = parse_agent_caps(Some(&caps));
        assert!(c.session_fork, "{{}} 表示支持");
        assert!(c.session_list, "true 表示支持");
        assert!(c.session_resume, "{{}} 表示支持");
        assert!(!c.session_delete, "null 表示不支持");
        assert!(!c.session_close, "缺失表示不支持");
    }

    /// MCP 族的字段同样按「出现过」判断。
    #[test]
    fn parses_mcp_capabilities_and_ignores_unknown_keys() {
        let caps = json!({
            "mcpCapabilities": { "http": true, "acp": {}, "sse": null },
            "notInProtocol": { "whatever": true }
        });
        let c = parse_agent_caps(Some(&caps));
        assert!(c.mcp_http);
        assert!(c.mcp_acp);
        assert!(!c.mcp_sse);
    }

    /// 没握手 / agentCapabilities 为 null 时全 false，不猜。
    #[test]
    fn missing_capabilities_are_all_false() {
        assert_eq!(parse_agent_caps(None), super::AgentCaps::default());
        assert_eq!(
            parse_agent_caps(Some(&json!(null))),
            super::AgentCaps::default()
        );
        assert_eq!(
            parse_agent_caps(Some(&json!({}))),
            super::AgentCaps::default()
        );
    }
}

/// agent 报上来的一个可选模式。只留 UI 要展示的字段。
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct ModeOption {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
}

/// 打开会话时的模式快照：`available` 用于校验目标值，`current` 是 agent 当时的生效值。
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
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
        // 能力要照实报：只开只读 `fs/read_text_file`，且实现限定在会话 cwd 子树内。
        // 写文件与终端仍报 false —— 这两项要等审批通道成熟后再开，否则 agent 会把
        // 高危操作甩给客户端，然后等一个永远不会来的响应。
        "clientCapabilities": {
            "fs": { "readTextFile": true, "writeTextFile": false },
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
            // 握手失败也不能只靠 Drop 杀 relay：WSL/SSH 的真正 agent 在远端，
            // 和正常断连一样要走同一棵进程树的回收。
            let _ = proc.kill_tree("disconnect").await;
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
