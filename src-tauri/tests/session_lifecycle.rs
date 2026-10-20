//! 会话生命周期：`session/new` 能真的拿到 sessionId。
//!
//! 默认 ignore —— 依赖本机 WSL + hermes。
//! 跑法：`cargo test --test session_lifecycle -- --ignored --nocapture`

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use sincearc_lib::acp::{initialize, transport::Incoming};
use sincearc_lib::acp::launch::{AgentProfile, Launch};

fn hermes_wsl() -> AgentProfile {
    AgentProfile {
        id: "p-hermes-wsl".into(),
        name: "Hermes (WSL)".into(),
        launch: Launch::Wsl {
            distro: "fedora".into(),
            shell: "zsh".into(),
        },
        program: "hermes".into(),
        args: vec!["acp".into()],
        env: BTreeMap::new(),
        default_cwd: PathBuf::from("/tmp"),
    }
}

#[tokio::test]
#[ignore = "needs WSL + hermes acp on this machine"]
async fn session_new_returns_an_id() {
    let profile = hermes_wsl();
    let (proc, _incoming, _outcome) = initialize(&profile, "/tmp", Duration::from_secs(60))
        .await
        .expect("handshake should succeed");

    let result = proc
        .request(
            "session/new",
            serde_json::json!({ "cwd": "/tmp", "mcpServers": [] }),
            Duration::from_secs(60),
        )
        .await
        .expect("session/new should succeed");

    println!("session/new = {result}");
    let session_id = result
        .get("sessionId")
        .and_then(serde_json::Value::as_str)
        .expect("response must carry sessionId");
    assert!(!session_id.is_empty());

    proc.kill().await;
}

/// 真跑一轮对话：验证 `session/prompt` 会推 `agent_message_chunk` 通知，
/// 且最终拿到 stopReason。会真的调用模型，所以默认 ignore。
#[tokio::test]
#[ignore = "calls a real model; needs WSL + hermes acp"]
async fn prompt_streams_chunks_then_finishes() {
    let profile = hermes_wsl();
    let (proc, mut incoming, _outcome) = initialize(&profile, "/tmp", Duration::from_secs(60))
        .await
        .expect("handshake should succeed");

    let created = proc
        .request(
            "session/new",
            serde_json::json!({ "cwd": "/tmp", "mcpServers": [] }),
            Duration::from_secs(60),
        )
        .await
        .expect("session/new should succeed");
    let session_id = created["sessionId"].as_str().expect("sessionId").to_string();

    // 收集通知：开着收包的 task，主线程去 await prompt
    let stats = std::sync::Arc::new(std::sync::Mutex::new((0usize, String::new())));
    let st = stats.clone();
    tokio::spawn(async move {
        while let Some(msg) = incoming.recv().await {
            if let Incoming::Notification { method, params } = msg {
                if method != "session/update" {
                    continue;
                }
                if params["update"]["sessionUpdate"] == "agent_message_chunk" {
                    let mut guard = st.lock().expect("stats poisoned");
                    guard.0 += 1;
                    if let Some(t) = params["update"]["content"]["text"].as_str() {
                        guard.1.push_str(t);
                    }
                }
            }
        }
    });

    let result = proc
        .request(
            "session/prompt",
            serde_json::json!({
                "sessionId": session_id,
                "prompt": [{ "type": "text", "text": "只回复两个字：收到" }],
            }),
            Duration::from_secs(180),
        )
        .await
        .expect("prompt should succeed");

    // 让最后几条通知落地
    tokio::time::sleep(Duration::from_millis(300)).await;
    let (chunks, text) = stats.lock().expect("stats poisoned").clone();
    println!("stopReason = {}", result["stopReason"]);
    println!("chunks = {chunks}, text = {text:?}");

    assert!(chunks > 0, "至少要收到一个 agent_message_chunk");
    assert!(!text.is_empty(), "拼起来的文本不该为空");
    assert!(result.get("stopReason").is_some(), "prompt 结果要带 stopReason");

    proc.kill().await;
}
