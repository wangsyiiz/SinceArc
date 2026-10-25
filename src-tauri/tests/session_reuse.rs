//! 会话复用：重连时 `session/load` 能不能接回上一次的会话。
//!
//! 这条决定了「每连一次就在 agent 侧留一个空会话」能不能根治 ——
//! 如果 load 不成立，就只能退回到「新建 + 定期清理」。

use std::time::Duration;

use sincearc_lib::acp::initialize;
use sincearc_lib::commands::{to_profile, ProfileDto};

fn wsl_profile() -> ProfileDto {
    ProfileDto {
        id: "p-hermes-wsl".into(),
        name: "Hermes (WSL)".into(),
        launch: "wsl".into(),
        program: "hermes".into(),
        args: vec!["acp".into()],
        cwd: "/mnt/c/source/sincearc".into(),
        distro: Some("fedora".into()),
        shell: Some("zsh".into()),
        ssh_host: None,
        ssh_port: None,
        ssh_user: None,
        ssh_auth: None,
        ssh_key_path: None,
        ssh_password: None,
        default_mode: None,
        default_mcp: None,
        caps: None,
        caps_at: None,
    }
}

#[tokio::test]
#[ignore = "needs WSL + hermes acp; starts two processes"]
async fn a_session_can_be_loaded_after_reconnect() {
    let dto = wsl_profile();
    let profile = to_profile(&dto).expect("convert");
    let cwd = dto.cwd.clone();

    // 第一次连接：建会话
    let (proc1, _in1, outcome1) = initialize(&profile, &cwd, Duration::from_secs(60))
        .await
        .expect("first handshake");
    assert!(outcome1.load_session, "agent 声称支持 loadSession");

    let created = proc1
        .request(
            "session/new",
            serde_json::json!({ "cwd": cwd, "mcpServers": [] }),
            Duration::from_secs(60),
        )
        .await
        .expect("session/new");
    let sid = created["sessionId"]
        .as_str()
        .expect("sessionId")
        .to_string();
    println!("created session = {sid}");

    proc1
        .request(
            "session/prompt",
            serde_json::json!({
                "sessionId": sid,
                "prompt": [{ "type": "text", "text": "只回复两个字：在" }],
            }),
            Duration::from_secs(180),
        )
        .await
        .expect("prompt");
    proc1.kill().await;
    tokio::time::sleep(Duration::from_millis(400)).await;

    // 第二次连接：load 同一个会话
    let (proc2, _in2, _outcome2) = initialize(&profile, &cwd, Duration::from_secs(60))
        .await
        .expect("second handshake");

    let loaded = proc2
        .request(
            "session/load",
            serde_json::json!({
                "sessionId": sid,
                "cwd": cwd,
                "mcpServers": [],
            }),
            Duration::from_secs(120),
        )
        .await;

    match &loaded {
        Ok(v) => println!("session/load ok: {v}"),
        Err(e) => panic!("session/load failed: {e}"),
    }

    // load 之后还能继续发消息，说明接的是同一个活会话
    let follow = proc2
        .request(
            "session/prompt",
            serde_json::json!({
                "sessionId": sid,
                "prompt": [{ "type": "text", "text": "只回复两个字：好" }],
            }),
            Duration::from_secs(180),
        )
        .await;
    assert!(follow.is_ok(), "load 之后应当还能继续对话: {follow:?}");

    proc2.kill().await;
}
