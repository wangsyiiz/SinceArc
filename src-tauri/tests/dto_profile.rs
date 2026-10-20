//! 前端传来的 JSON 能否原样变成可启动的 profile。
//!
//! 这条路径与 command 层完全一致（同一个 ProfileDto 与 to_profile），
//! 用来把「DTO 转换错」与「运行环境找不到 wsl.exe」分开。

use std::time::Duration;

use sincearc_lib::acp::initialize;
use sincearc_lib::commands::{to_profile, ProfileDto};

fn frontend_json(cwd: &str) -> serde_json::Value {
    serde_json::json!({
        "id": "p-hermes-wsl",
        "name": "Hermes (WSL)",
        "launch": "wsl",
        "program": "hermes",
        "args": ["acp"],
        "cwd": cwd,
        "distro": "fedora",
        "shell": "zsh",
        "sshPort": 22
    })
}

#[test]
fn frontend_shape_deserializes() {
    let dto: ProfileDto = serde_json::from_value(frontend_json("/home/jerry")).unwrap();
    assert_eq!(dto.launch, "wsl");
    assert_eq!(dto.program, "hermes");
    assert_eq!(dto.args, vec!["acp".to_string()]);
    assert_eq!(dto.distro.as_deref(), Some("fedora"));
    assert_eq!(dto.shell.as_deref(), Some("zsh"));

    let profile = to_profile(&dto).expect("wsl profile should convert");
    let (program, args) = (profile.program.clone(), profile.args.clone());
    assert_eq!(program, "hermes");
    assert_eq!(args, vec!["acp".to_string()]);
}

#[tokio::test]
#[ignore = "needs WSL + hermes acp on this machine"]
async fn dto_path_completes_handshake() {
    let cwd = "/home/jerry";
    let dto: ProfileDto = serde_json::from_value(frontend_json(cwd)).unwrap();
    let profile = to_profile(&dto).expect("convert");

    let (proc, _incoming, outcome) = initialize(&profile, cwd, Duration::from_secs(60))
        .await
        .expect("handshake via DTO path should succeed");

    println!("outcome = {outcome:#?}");
    assert_eq!(outcome.agent_name, "hermes-agent");
    proc.kill().await;
}
