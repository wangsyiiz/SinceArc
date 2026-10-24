//! 成员投递链路的真机验证：同一个进程里 load 一个会话，再向它发 prompt。
//!
//! 这正是群里 `@成员` 走的路（docs/group-chat.md §3）：
//! 连接建立 → 把成员的会话 load 进来 → 向那个 sessionId 发 prompt。
//!   cargo test --test member_prompt -- --ignored --nocapture

use std::time::Duration;

use sincearc_lib::acp;
use sincearc_lib::commands::{to_profile, ProfileDto};

fn hermes() -> ProfileDto {
    ProfileDto {
        id: "p-member".into(),
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
async fn 成员会话_load_之后能直接收_prompt() {
    let dto = hermes();
    let parsed = to_profile(&dto).expect("profile");
    let cwd = dto.cwd.clone();

    // 1) 起进程、建一个会话（模拟「主 agent 的会话」）
    let (proc, mut incoming, _o) = acp::initialize(&parsed, &cwd, Duration::from_secs(30))
        .await
        .expect("initialize");
    let created = proc
        .request(
            "session/new",
            serde_json::json!({"cwd": cwd, "mcpServers": []}),
            Duration::from_secs(120),
        )
        .await
        .expect("session/new");
    let member_sid = created["sessionId"]
        .as_str()
        .expect("sessionId")
        .to_string();
    println!("member sessionId = {member_sid}");
    proc.kill().await;

    // 2) 新进程：先建主会话，再把成员会话 load 进来（这是界面里「点 @」时发生的事）
    let (proc2, mut incoming2, _o2) = acp::initialize(&parsed, &cwd, Duration::from_secs(30))
        .await
        .expect("initialize #2");
    let loaded = proc2
        .request(
            "session/load",
            serde_json::json!({"sessionId": member_sid, "cwd": cwd, "mcpServers": []}),
            Duration::from_secs(120),
        )
        .await;
    assert!(loaded.is_ok(), "load 失败：{loaded:?}");
    println!("member session loaded ok");

    // 3) 向它发 prompt —— load 之后 PromptRequest 才会被接受
    proc2
        .request(
            "session/prompt",
            serde_json::json!({
                "sessionId": member_sid,
                "prompt": [{"type": "text", "text": "只回复两个字：收到"}],
            }),
            Duration::from_secs(180),
        )
        .await
        .expect("session/prompt");

    // 收几条事件，证明这条会话真的在回答（不只是没报错）
    let mut seen = 0;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        match tokio::time::timeout_at(deadline, incoming2.recv()).await {
            Ok(Some(ev)) => {
                let s = format!("{ev:?}");
                if s.contains("agent_message_chunk") {
                    seen += 1;
                    if seen >= 1 {
                        println!("收到 agent_message_chunk");
                        break;
                    }
                }
            }
            Ok(None) => break,
            Err(_) => break,
        }
    }
    proc2.kill().await;
    let _ = (&mut incoming, &mut incoming2);
    assert!(seen > 0, "prompt 发出去了但没收到任何 agent_message_chunk");
}
