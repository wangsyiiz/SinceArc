//! 模式切换：`session/new` 报上来的 modes 能不能解析、`set_mode` 之后能不能读回、
//! 未知模式会不会被拒绝且不动原值。
//!
//! 这是 docs/modes-spec.md §2 那几条实测结论的可执行版本 —— 规范里写「实测过」的地方，
//! 这里必须有对应的断言，否则下次协议变了没人知道。

use std::time::Duration;

use serde_json::json;
use sincearc_lib::acp::{initialize, modes_from_response};
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
        caps: None,
        caps_at: None,
    }
}

#[tokio::test]
#[ignore = "needs WSL + hermes acp; starts a process"]
async fn modes_are_reported_and_set_mode_sticks() {
    let dto = wsl_profile();
    let profile = to_profile(&dto).expect("convert");
    let cwd = dto.cwd.clone();

    let (proc, _incoming, _outcome) = initialize(&profile, &cwd, Duration::from_secs(60))
        .await
        .expect("handshake");

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

    let modes = modes_from_response(&created).expect("session/new 应当报上来 modes");
    let ids: Vec<&str> = modes.available.iter().map(|m| m.id.as_str()).collect();
    println!("session/new modes = {ids:?}, current = {}", modes.current);
    assert!(
        ids.contains(&"dont_ask"),
        "hermes 应当提供 dont_ask，实际给了 {ids:?}"
    );

    // 推一个存在的档
    proc.request(
        "session/set_mode",
        json!({ "sessionId": sid, "modeId": "dont_ask" }),
        Duration::from_secs(60),
    )
    .await
    .expect("set_mode 应当成功");

    // load 读回 currentModeId —— 这条证明「推上去的值真的生效了」
    let loaded = proc
        .request(
            "session/load",
            json!({ "sessionId": sid, "cwd": cwd, "mcpServers": [] }),
            Duration::from_secs(120),
        )
        .await
        .expect("session/load");
    let after = modes_from_response(&loaded).expect("load 应当报上来 modes");
    assert_eq!(after.current, "dont_ask", "set_mode 之后 load 应读回同一值");

    // 未知的档：必须被拒绝，而且不能顺手把原值改掉
    let bogus = proc
        .request(
            "session/set_mode",
            json!({ "sessionId": sid, "modeId": "no_such_mode" }),
            Duration::from_secs(60),
        )
        .await;
    assert!(bogus.is_err(), "未知模式必须被拒绝（不能静默接受）");

    let again = proc
        .request(
            "session/load",
            json!({ "sessionId": sid, "cwd": cwd, "mcpServers": [] }),
            Duration::from_secs(120),
        )
        .await
        .expect("session/load again");
    assert_eq!(
        modes_from_response(&again).expect("modes").current,
        "dont_ask",
        "失败的 set_mode 不该改动原值"
    );

    proc.kill().await;
}
