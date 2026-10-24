//! 真机验证 `agent_user_test` 的核心动作：session/new 建一个会话，再在新进程里 session/load 回来。
//!
//! 这条链是「agent user 能当玩家」的前提（docs/group-chat.md §2）。
//!   cargo test --test agent_user_test -- --ignored --nocapture

use std::time::Duration;

use sincearc_lib::acp;
use sincearc_lib::commands::{to_profile, ProfileDto};

fn hermes_profile() -> ProfileDto {
    ProfileDto {
        id: "p-agent-user".into(),
        name: "hermes".into(),
        launch: "wsl".into(),
        program: "hermes".into(),
        args: vec!["acp".into()],
        cwd: "/home/jerry/source".into(),
        default_mode: None,
        caps: None,
        caps_at: None,
        distro: Some("fedora".into()),
        shell: Some("bash".into()),
        ssh_host: None,
        ssh_port: None,
        ssh_user: None,
        ssh_auth: None,
        ssh_key_path: None,
        ssh_password: None,
    }
}

#[tokio::test]
#[ignore]
async fn session_load_能把新建的会话恢复回来() {
    let dto = hermes_profile();
    let parsed = to_profile(&dto).expect("profile");
    let cwd = dto.cwd.clone();

    // 1) 起一个 agent，新建会话
    let (proc, _incoming, outcome) = acp::initialize(&parsed, &cwd, Duration::from_secs(30))
        .await
        .expect("initialize");
    println!("agent = {} {}", outcome.agent_name, outcome.agent_version);
    assert!(
        outcome.load_session,
        "{} 没报 loadSession，这个 agent 当不了玩家",
        outcome.agent_name
    );
    let created = proc
        .request(
            "session/new",
            serde_json::json!({"cwd": cwd, "mcpServers": []}),
            Duration::from_secs(120),
        )
        .await
        .expect("session/new");
    let sid = created
        .get("sessionId")
        .and_then(|v| v.as_str())
        .expect("session/new 没给 sessionId")
        .to_string();
    println!("new sessionId = {sid}");
    proc.kill().await;

    // 2) 换一个进程把它 load 回来 —— 这才是「玩家能复活」的证据
    let (proc2, _incoming2, _o2) = acp::initialize(&parsed, &cwd, Duration::from_secs(30))
        .await
        .expect("initialize #2");
    let loaded = proc2
        .request(
            "session/load",
            serde_json::json!({"sessionId": sid, "cwd": cwd, "mcpServers": []}),
            Duration::from_secs(120),
        )
        .await;
    proc2.kill().await;

    match loaded {
        Ok(v) => println!("load ok -> {}", v),
        Err(e) => panic!("同一个 id 在新进程里 load 失败：{e}"),
    }
}

#[tokio::test]
#[ignore]
async fn 假_session_id_会失败而不是假装成功() {
    let dto = hermes_profile();
    let parsed = to_profile(&dto).expect("profile");
    let (proc, _incoming, _o) = acp::initialize(&parsed, &dto.cwd, Duration::from_secs(30))
        .await
        .expect("initialize");
    let res = proc
        .request(
            "session/load",
            serde_json::json!({"sessionId": "s-does-not-exist", "cwd": dto.cwd, "mcpServers": []}),
            Duration::from_secs(60),
        )
        .await;
    proc.kill().await;
    assert!(res.is_err(), "不存在的会话居然 load 成功了：{res:?}");
    println!("预期的失败：{}", res.unwrap_err());
}
