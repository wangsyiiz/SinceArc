//! 会话生命周期：`session/new` 能真的拿到 sessionId。
//!
//! 默认 ignore —— 依赖本机 WSL + hermes。
//! 跑法：`cargo test --test session_lifecycle -- --ignored --nocapture`

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use sincearc_lib::acp::initialize;
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
