//! SSH 扫描的真机验证（需要一台能连的机器）。
//!
//! 默认跳过：没有凭据时跑它没有意义，还会让人以为「SSH 扫描坏了」。
//!   SINCEARC_SSH_HOST=localhost SINCEARC_SSH_USER=jerry SINCEARC_SSH_PASSWORD=... \
//!   cargo test --test discovery_ssh -- --ignored --nocapture
//!
//! 只扫「用户已存连接配置」的 host（docs/discovery.md §3），所以这里故意用一条假 profile 驱动，
//! 走的就是设置页里那条连接会走的路。

use sincearc_lib::acp::discover;
use sincearc_lib::commands::{agent_discover_for_test, ProfileDto};

fn env_or(name: &str, fallback: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| fallback.to_string())
}

#[tokio::test]
#[ignore]
async fn ssh_扫描能找到远端已装的_agent() {
    let password = match std::env::var("SINCEARC_SSH_PASSWORD") {
        Ok(v) if !v.is_empty() => v,
        _ => {
            println!("跳过：没有设置 SINCEARC_SSH_PASSWORD");
            return;
        }
    };
    let profile = ProfileDto {
        id: "p-ssh-test".into(),
        name: "ssh-test".into(),
        launch: "ssh".into(),
        program: "hermes".into(),
        args: vec!["acp".into()],
        cwd: "/tmp".into(),
        default_mode: None,
        default_mcp: None,
        caps: None,
        caps_at: None,
        distro: None,
        shell: None,
        ssh_host: Some(env_or("SINCEARC_SSH_HOST", "localhost")),
        ssh_port: Some(22),
        ssh_user: Some(env_or("SINCEARC_SSH_USER", "jerry")),
        ssh_auth: Some("password".into()),
        ssh_key_path: None,
        ssh_password: Some(password),
    };

    let outcome = agent_discover_for_test(vec![profile]).await;
    println!("warnings = {:#?}", outcome.warnings);
    for f in &outcome.found {
        println!("  ✓ {} @ {} · {}", f.candidate_id, f.host, f.path);
    }
    assert!(
        outcome.warnings.is_empty(),
        "SSH 扫描不该产生警告：{:#?}",
        outcome.warnings
    );
    assert!(
        outcome.found.iter().any(|f| f.host.starts_with("ssh:")),
        "没有任何 ssh: 命中 —— 远端是不是一个 agent 都没装？"
    );
}

#[test]
fn 候选表至少有一条_native() {
    assert!(discover::CANDIDATES.iter().any(|c| c.mode == "native"));
}
