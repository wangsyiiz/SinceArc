//! 探针：`session/new` 里给的 `cwd` 到底管不管 agent 自己的工具？
//!
//! 这决定「工作目录」这个设置项对自带工具的 agent 有没有意义：
//! - 如果 agent 的 `pwd` / 相对路径操作跟着 session cwd 走 → 这一项是「让它改哪个项目」的唯一入口，不能藏；
//! - 如果它只认进程启动目录 → 那这一项只影响我们的文件代读沙箱，藏起来才不会误导。
//!
//!   cargo test --test cwd_probe -- --ignored --nocapture

use std::time::Duration;

use sincearc_lib::acp;
use sincearc_lib::commands::{to_profile, ProfileDto};

fn hermes() -> ProfileDto {
    ProfileDto {
        id: "p-cwd-probe".into(),
        name: "hermes".into(),
        launch: "wsl".into(),
        program: "hermes".into(),
        args: vec!["acp".into()],
        // 进程启动目录与 session cwd 故意不同，才能分清它认哪个
        cwd: "/home/jerry".into(),
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
async fn session_cwd_对_agent_自己的工具是否生效() {
    let dto = hermes();
    let parsed = to_profile(&dto).expect("profile");
    let launch_cwd = dto.cwd.clone();

    // 造一个一眼能认出来的目录，避免和 /home/jerry、/tmp 之类撞脸
    let probe_dir = "/home/jerry/cwd-probe-sincearc";
    std::fs::create_dir_all(probe_dir).expect("mkdir");

    let (proc, mut incoming, _o) = acp::initialize(&parsed, &launch_cwd, Duration::from_secs(30))
        .await
        .expect("initialize");

    let created = proc
        .request(
            "session/new",
            serde_json::json!({ "cwd": probe_dir, "mcpServers": [] }),
            Duration::from_secs(120),
        )
        .await
        .expect("session/new");
    let sid = created["sessionId"].as_str().expect("sid").to_string();
    println!("probe session = {sid}, session cwd = {probe_dir}, launch cwd = {launch_cwd}");

    // 让它自己跑一次 pwd：输出就是「它认为自己在哪」
    // 注意：通知必须与请求**并发**消费，等 request 返回再读会漏掉流式内容。
    let seen = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::<String>::new()));
    let seen_task = seen.clone();
    let reader = tokio::spawn(async move {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(240);
        while tokio::time::Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(400), incoming.recv()).await {
                Ok(Some(msg)) => seen_task.lock().await.push(format!("{msg:?}")),
                Ok(None) => break,
                Err(_) => {}
            }
        }
    });

    let _ = proc
        .request(
            "session/prompt",
            serde_json::json!({
                "sessionId": sid,
                "prompt": [{ "type": "text", "text": "用终端执行 pwd，把原始输出贴出来，不要解释。" }],
            }),
            Duration::from_secs(180),
        )
        .await
        .expect("prompt");

    // 给尾巴一点时间（usage / 最后几段 chunk）
    tokio::time::sleep(Duration::from_millis(1200)).await;
    reader.abort();
    proc.kill().await;

    let all = seen.lock().await.clone();
    let mut text = String::new();
    let mut tools: Vec<String> = Vec::new();
    for m in &all {
        if m.contains("agent_message_chunk") {
            if let Some(t) = field_of(m, "text") {
                text.push_str(&t);
            }
        }
        if m.contains("tool_call") && !m.contains("tool_call_update") {
            if let Some(t) = field_of(m, "title") {
                tools.push(t);
            }
        }
    }
    println!("消息数 = {}", all.len());
    println!("工具调用 = {tools:?}");
    println!("回答文本 = {text}");
    println!(
        "结论：{}",
        if text.contains(probe_dir) {
            "agent 的工具跟着 session cwd 走"
        } else if text.contains(&launch_cwd) {
            "agent 的工具跟着进程启动目录走"
        } else {
            "两者都没命中；把上面的原始消息贴出来人工判断"
        }
    );
    if !text.contains(probe_dir) && !text.contains(&launch_cwd) {
        for m in all.iter().take(6) {
            println!("RAW: {}", &m[..m.len().min(400)]);
        }
    }
}

/// 从 Debug 串里取一个字符串字段（`"text": String("…")` 或 `"text": "…"` 两种形态都吃）
fn field_of(s: &str, key: &str) -> Option<String> {
    let idx = s.find(&format!("\"{key}\":"))?;
    let rest = s[idx..].split_once(':')?.1.trim_start();
    let rest = rest.strip_prefix("String(").unwrap_or(rest);
    let rest = rest.strip_prefix('"')?;
    Some(rest.split('"').next().unwrap_or("").to_string())
}
