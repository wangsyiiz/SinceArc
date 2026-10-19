//! 端到端握手：真的起 `wsl.exe -d fedora … hermes acp`。
//!
//! 默认 ignore —— 它依赖本机 WSL 发行版与 hermes 安装。
//! 手动跑：`cargo test --test initialize_handshake -- --ignored --nocapture`

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use sincearc_lib::acp::launch::{AgentProfile, Launch};
use sincearc_lib::acp::initialize;

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
        default_cwd: PathBuf::from("/home/jerry"),
    }
}

#[tokio::test]
#[ignore = "needs WSL + hermes acp on this machine"]
async fn hermes_acp_handshake_reports_agent_info() {
    let profile = hermes_wsl();
    let (mut proc, outcome) = initialize(&profile, "/home/jerry", Duration::from_secs(60))
        .await
        .expect("handshake should succeed");

    println!("outcome = {outcome:#?}");
    assert_eq!(outcome.protocol_version, 1);
    assert_eq!(outcome.agent_name, "hermes-agent");
    assert!(!outcome.agent_version.is_empty());
    assert!(outcome.load_session, "hermes advertises loadSession");

    let _ = proc.child.kill().await;
}
