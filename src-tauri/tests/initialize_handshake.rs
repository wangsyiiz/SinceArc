//! 端到端握手：真的起 `wsl.exe -d fedora … hermes acp`。
//!
//! 默认 ignore —— 它依赖本机 WSL 发行版与 hermes 安装。
//! 手动跑：`cargo test --test initialize_handshake -- --ignored --nocapture`

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
        default_cwd: PathBuf::from("/home/jerry"),
    }
}

#[tokio::test]
#[ignore = "needs WSL + hermes acp on this machine"]
async fn hermes_acp_handshake_reports_agent_info() {
    let profile = hermes_wsl();
    let (proc, _incoming, outcome) = initialize(&profile, "/home/jerry", Duration::from_secs(60))
        .await
        .expect("handshake should succeed");

    println!("outcome = {outcome:#?}");
    assert_eq!(outcome.protocol_version, 1);
    assert_eq!(outcome.agent_name, "hermes-agent");
    assert!(!outcome.agent_version.is_empty());
    assert!(outcome.load_session, "hermes advertises loadSession");

    proc.kill().await;
}

/// S0 的核心承诺：并发请求靠 id 配对，不串号。
/// 两个请求交错发出，一个合法一个不存在 —— 若实现是「读一行就当前请求的响应」，
/// 这里会拿到对方的 result/error。
#[tokio::test]
#[ignore = "needs WSL + hermes acp on this machine"]
async fn concurrent_requests_do_not_cross_wire() {
    let profile = hermes_wsl();
    let (proc, _incoming, _outcome) = initialize(&profile, "/home/jerry", Duration::from_secs(60))
        .await
        .expect("handshake should succeed");

    let ok = proc.request(
        "session/list",
        serde_json::json!({}),
        Duration::from_secs(30),
    );
    let bad = proc.request(
        "__sincearc_nonexistent_method__",
        serde_json::json!({}),
        Duration::from_secs(30),
    );
    let (ok_res, bad_res) = tokio::join!(ok, bad);

    // hermes 对未知 method 不报错，回 result:null（实测），所以判据是「两个响应的内容各归各位」：
    // 串号的话 session/list 会拿到 null、未知 method 会拿到 sessions。
    let ok_v = ok_res.expect("session/list should succeed");
    let bad_v = bad_res.expect("hermes answers unknown methods with result:null");
    assert!(
        ok_v.get("sessions").is_some(),
        "session/list must carry a sessions field, got {ok_v:?}"
    );
    assert!(
        bad_v.is_null(),
        "unknown method → result:null, got {bad_v:?}"
    );

    proc.kill().await;
}
