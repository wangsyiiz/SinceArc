//! 权限应答通道：agent 真的会发 `session/request_permission` 吗？我们回一条
//! `{"outcome":{"outcome":"selected","optionId":...}}` 之后，那一轮 prompt 会不会正常收尾？
//!
//! 这是 E3 权限链路的可执行证据 —— `docs/modes-spec.md` 之外的第二个协议事实：
//! 光有 UI 不够，必须证明「回答能让 agent 继续跑」，否则界面上点了按钮也只是往
//! 虚空里写一条 JSON。

use std::time::Duration;

use serde_json::{json, Value};
use sincearc_lib::acp::initialize;
use sincearc_lib::commands::{to_profile, ProfileDto};

fn wsl_profile(mode: Option<&str>) -> ProfileDto {
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
        default_mode: mode.map(str::to_string),
    }
}

/// 从 `session/request_permission` 的 params 里挑一个选项 id。
/// 按 kind 挑而不是按下标挑：协议说 kind 只是提示，但选项顺序更不可靠。
fn pick_option(params: &Value, want: &[&str]) -> String {
    let options = params["options"].as_array().expect("options 必须是数组");
    for o in options {
        let kind = o["kind"].as_str().unwrap_or_default();
        if want.contains(&kind) {
            return o["optionId"].as_str().expect("optionId").to_string();
        }
    }
    panic!("没找到 kind ∈ {want:?} 的选项，实际给了 {options:?}");
}

#[tokio::test]
#[ignore = "needs WSL + hermes acp; starts a process and runs a real turn"]
async fn permission_request_can_be_answered() {
    let dto = wsl_profile(None);
    let profile = to_profile(&dto).expect("convert");
    let cwd = dto.cwd.clone();

    let (proc, mut incoming, _outcome) = initialize(&profile, &cwd, Duration::from_secs(60))
        .await
        .expect("handshake");
    // prompt 与「回答权限请求」必须并行，进程句柄因此要共享
    let proc = std::sync::Arc::new(proc);

    let created = proc
        .request(
            "session/new",
            json!({ "cwd": cwd, "mcpServers": [] }),
            Duration::from_secs(60),
        )
        .await
        .expect("session/new");
    let sid = created["sessionId"]
        .as_str()
        .expect("sessionId")
        .to_string();

    // 回到「改文件前问」—— 这是权限请求会出现的前提
    proc.request(
        "session/set_mode",
        json!({ "sessionId": sid, "modeId": "default" }),
        Duration::from_secs(60),
    )
    .await
    .expect("set_mode default");

    // prompt 会一直挂到我们回答权限请求为止，所以必须并行跑
    let prompt_proc = std::sync::Arc::clone(&proc);
    let prompt_sid = sid.clone();
    let turn = tokio::spawn(async move {
        prompt_proc
            .request(
                "session/prompt",
                json!({
                    "sessionId": prompt_sid,
                    "prompt": [{
                        "type": "text",
                        "text": "在当前目录新建文件 perm_probe.txt，内容写 hello。只做这一件事。"
                    }]
                }),
                Duration::from_secs(180),
            )
            .await
    });

    // 等 agent 来问权限
    let mut asked: Option<(u64, Value)> = None;
    for _ in 0..200 {
        let msg = tokio::time::timeout(Duration::from_secs(60), incoming.recv())
            .await
            .expect("等权限请求超时：agent 没有发 session/request_permission");
        let Some(msg) = msg else { break };
        if let sincearc_lib::acp::transport::Incoming::Request { id, method, params } = msg {
            if method == "session/request_permission" {
                asked = Some((id, params));
                break;
            }
        }
    }
    let (req_id, params) = asked.expect("应当收到 session/request_permission");
    println!("permission params = {params}");
    assert!(
        params["sessionId"].as_str() == Some(sid.as_str()),
        "请求应当指向我们刚建的会话"
    );
    assert!(
        params["toolCall"].is_object(),
        "params 里应当带 toolCall（界面要拿它显示在做什么）"
    );

    // 选「允许一次」：答完这一轮应当自己跑完
    let option_id = pick_option(&params, &["allow_once"]);
    proc.respond(
        req_id,
        Ok(json!({ "outcome": { "outcome": "selected", "optionId": option_id } })),
    )
    .await
    .expect("respond");

    let result = tokio::time::timeout(Duration::from_secs(180), turn)
        .await
        .expect("回答之后 prompt 应当收尾（否则说明响应没被 agent 接受）")
        .expect("join")
        .expect("prompt 应当成功");
    println!("prompt result = {result}");
    assert!(result["stopReason"].is_string(), "prompt 应当带 stopReason");

    // 重复回答同一个 id 必须被 agent 侧忽略/报错，而不是把这一轮搞坏。
    // 这条锁的是「界面双击」的真实后果：客户端要挡在登记表上（见 agent_respond_request），
    // 这里只记录 agent 的反应，不做硬断言。
    let _ = proc
        .respond(
            req_id,
            Ok(json!({ "outcome": { "outcome": "selected", "optionId": "allow_once" } })),
        )
        .await;

    proc.kill().await;
}

#[tokio::test]
#[ignore = "needs WSL + hermes acp; starts a process and runs a real turn"]
async fn dont_ask_mode_runs_the_same_turn_without_asking() {
    // 对照组：同一个任务在 dont_ask 下不需要任何人回答。
    // 如果这条也收到权限请求，说明模式没生效 —— 那界面上的「自动放行」是假的。
    let dto = wsl_profile(Some("dont_ask"));
    let profile = to_profile(&dto).expect("convert");
    let cwd = dto.cwd.clone();

    let (proc, mut incoming, _outcome) = initialize(&profile, &cwd, Duration::from_secs(60))
        .await
        .expect("handshake");
    // prompt 与「回答权限请求」必须并行，进程句柄因此要共享
    let proc = std::sync::Arc::new(proc);
    let created = proc
        .request(
            "session/new",
            json!({ "cwd": cwd, "mcpServers": [] }),
            Duration::from_secs(60),
        )
        .await
        .expect("session/new");
    let sid = created["sessionId"]
        .as_str()
        .expect("sessionId")
        .to_string();
    proc.request(
        "session/set_mode",
        json!({ "sessionId": sid, "modeId": "dont_ask" }),
        Duration::from_secs(60),
    )
    .await
    .expect("set_mode dont_ask");

    let prompt_proc = std::sync::Arc::clone(&proc);
    let prompt_sid = sid.clone();
    let turn = tokio::spawn(async move {
        prompt_proc
            .request(
                "session/prompt",
                json!({
                    "sessionId": prompt_sid,
                    "prompt": [{
                        "type": "text",
                        "text": "在当前目录新建文件 perm_probe_2.txt，内容写 hello。只做这一件事。"
                    }]
                }),
                Duration::from_secs(180),
            )
            .await
    });

    let result = tokio::time::timeout(Duration::from_secs(180), turn)
        .await
        .expect("dont_ask 下不该卡住等权限")
        .expect("join")
        .expect("prompt");
    println!("dont_ask prompt result = {result}");

    // 跑完之后再看有没有迟到/意外的权限请求：有就是模式没生效的证据
    while let Ok(Some(msg)) =
        tokio::time::timeout(Duration::from_millis(300), incoming.recv()).await
    {
        if let sincearc_lib::acp::transport::Incoming::Request { method, .. } = msg {
            assert_ne!(
                method, "session/request_permission",
                "dont_ask 模式下不应该再问权限"
            );
        }
    }

    proc.kill().await;
}
