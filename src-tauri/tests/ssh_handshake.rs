//! 经 ssh 起 agent 的端到端握手（本地 = ssh localhost，与远程同一条代码路径）。
//!
//! 默认 ignore —— 依赖 WSL 里的 sshd 与该用户的密码。
//! 跑法：
//! ```text
//! SINCEARC_SSH_PASSWORD=*** cargo test --test ssh_handshake -- --ignored --nocapture
//! ```

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use sincearc_lib::acp::initialize;
use sincearc_lib::acp::launch::{AgentProfile, Launch, SshAuth, SshSpec};

fn ssh_localhost() -> AgentProfile {
    let secret = std::env::var("SINCEARC_SSH_PASSWORD")
        .expect("set SINCEARC_SSH_PASSWORD to the ssh user's password");

    AgentProfile {
        id: "p-ssh-local".into(),
        name: "Hermes (ssh localhost)".into(),
        launch: Launch::Ssh(SshSpec {
            host: "localhost".into(),
            port: 22,
            user: "jerry".into(),
            auth: SshAuth::Password { secret },
        }),
        program: "hermes".into(),
        args: vec!["acp".into()],
        env: BTreeMap::new(),
        default_cwd: PathBuf::from("/home/jerry"),
    }
}

#[tokio::test]
#[ignore = "needs WSL sshd + SINCEARC_SSH_PASSWORD"]
async fn ssh_password_handshake_reports_agent_info() {
    let profile = ssh_localhost();
    let (proc, _incoming, outcome) = initialize(&profile, "/home/jerry", Duration::from_secs(90))
        .await
        .expect("ssh handshake should succeed");

    println!("outcome = {outcome:#?}");
    assert_eq!(outcome.protocol_version, 1);
    assert_eq!(outcome.agent_name, "hermes-agent");
    assert!(!outcome.agent_version.is_empty());

    proc.kill().await;
}
