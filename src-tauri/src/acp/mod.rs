//! ACP 接入层。
//!
//! 设计约束（见 docs/acp-notes.md）：
//! 1. 所有协议类型只出现在本模块内 —— UI 只消费 `AcpEvent` 自己的枚举。
//! 2. 进程由我们自己起（tokio::process），不用 crate 的 `process` feature：
//!    WSL 场景中间隔着 `wsl.exe` relay，需要 setsid + 自己记 pid 才能干净杀掉。
//! 3. 协议版本显式钉 v1；`unstable_protocol_v2` 不启用。

pub mod launch;
pub mod transport;

use std::time::Duration;

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
        }
    }
}

/// 起进程并完成握手。返回会话外壳与 outcome。
pub async fn initialize(
    profile: &AgentProfile,
    cwd: &str,
    timeout: Duration,
) -> Result<(transport::AgentProcess, InitializeOutcome), transport::TransportError> {
    let (mut proc, mut stderr) = transport::spawn(profile, cwd)?;

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
        "clientCapabilities": {
            "fs": { "readTextFile": true, "writeTextFile": true },
            "terminal": true
        }
    });

    match transport::request(&mut proc, 1, "initialize", params, timeout).await {
        Ok(result) => {
            if result.get("protocolVersion").and_then(Value::as_i64) != Some(1) {
                tracing::warn!(target: "sincearc::acp", "agent negotiated an unexpected protocol version");
            }
            Ok((proc, InitializeOutcome::from_result(&result)))
        }
        Err(e) => {
            let buf = stderr_tail.lock().expect("stderr tail poisoned");
            if !buf.is_empty() {
                tracing::error!(target: "sincearc::acp", "agent stderr tail:\n{}", buf.join("\n"));
            }
            Err(e)
        }
    }
}

/// 给前端的能力探测占位：E1 之后改成真结果。
#[tauri::command]
pub fn list_profiles_hint() -> Vec<&'static str> {
    vec!["wsl:hermes acp", "local:mock"]
}
