//! 探针：agent 在 `session/load` 之后到底重放什么。
//!
//! 这决定「轨迹要不要我们自己落库」：
//! - 如果重放里包含 tool_call / tool_call_update，我们理论上可以从 agent 侧重建操作轨迹；
//! - 如果只有 agent_message_chunk（文本），那「思考与操作」在 ACP 这一层根本取不回来，
//!   必须由我们在**事件发生的那一刻**自己记。
//!
//!   cargo test --test replay_probe -- --ignored --nocapture

use std::time::Duration;

use sincearc_lib::acp;
use sincearc_lib::commands::{to_profile, ProfileDto};

fn hermes() -> ProfileDto {
    ProfileDto {
        id: "p-probe".into(),
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
async fn 重放里有没有工具调用() {
    let dto = hermes();
    let parsed = to_profile(&dto).expect("profile");
    let cwd = dto.cwd.clone();

    // 1) 起一个会话，问一句会触发工具调用的话（让它留下 tool_call 记录）
    let (proc, _incoming, _o) = acp::initialize(&parsed, &cwd, Duration::from_secs(30))
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
    let sid = created["sessionId"].as_str().expect("sid").to_string();
    println!("probe session = {sid}");

    // 两轮，各让它干一件会产生 tool_call 的小事：用来判断重放是「整段历史」还是「最后一轮」
    for ask in [
        "在 /tmp 下用命令看一眼当前时间，然后告诉我结果。",
        "再用命令看一眼当前目录路径，然后告诉我结果。",
    ] {
        let _ = proc
            .request(
                "session/prompt",
                serde_json::json!({
                    "sessionId": sid,
                    "prompt": [{ "type": "text", "text": ask }],
                }),
                Duration::from_secs(300),
            )
            .await;
    }
    proc.kill().await;

    // 2) 新进程：load 同一个会话，看它重放哪些事件、有没有 tool_call
    let (proc2, mut incoming, _o2) = acp::initialize(&parsed, &cwd, Duration::from_secs(30))
        .await
        .expect("initialize2");
    proc2
        .request(
            "session/load",
            serde_json::json!({"sessionId": sid, "cwd": cwd, "mcpServers": []}),
            Duration::from_secs(120),
        )
        .await
        .expect("session/load");

    let mut kinds: Vec<String> = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(500), incoming.recv()).await {
            Ok(Some(msg)) => {
                let text = format!("{msg:?}");
                let kind = if text.contains("tool_call_update") {
                    "tool_call_update"
                } else if text.contains("tool_call") {
                    "tool_call"
                } else if text.contains("agent_message_chunk") {
                    "agent_message_chunk"
                } else if text.contains("agent_thought_chunk") {
                    "agent_thought_chunk"
                } else if text.contains("usage_update") {
                    "usage_update"
                } else {
                    "other"
                };
                kinds.push(kind.to_string());
            }
            Ok(None) => break,
            Err(_) => {}
        }
    }
    proc2.kill().await;

    let count = |k: &str| kinds.iter().filter(|x| *x == k).count();
    println!(
        "重放事件统计：chunk={} thought={} tool_call={} tool_call_update={} usage={} other={}",
        count("agent_message_chunk"),
        count("agent_thought_chunk"),
        count("tool_call"),
        count("tool_call_update"),
        count("usage_update"),
        count("other"),
    );
    println!("序列：{kinds:?}");
}
