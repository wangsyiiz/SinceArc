//! 探测命令：`agent_probe` 的核心是「真跑一次 initialize」。
//!
//! 两条断言：
//! 1) 起不来的命令（不存在的 program）必须报错，而不是假装成功 ——
//!    否则设置页会给用户一个「已连接」的假绿灯。
//! 2) 对真实的 hermes acp，必须报出 agentInfo 里的名字与版本，
//!    这样「这条命令是不是 ACP agent」才有证据，而不是靠命令名猜。

use std::time::Duration;

use sincearc_lib::acp::initialize;
use sincearc_lib::commands::{to_profile, ProfileDto};

fn wsl_profile(program: &str, args: &[&str]) -> ProfileDto {
    ProfileDto {
        id: "p-probe".into(),
        name: "probe".into(),
        launch: "wsl".into(),
        program: program.into(),
        args: args.iter().map(|s| s.to_string()).collect(),
        cwd: "/home/jerry".into(),
        distro: Some("fedora".into()),
        shell: Some("zsh".into()),
        ssh_host: None,
        ssh_port: None,
        ssh_user: None,
        ssh_auth: None,
        ssh_key_path: None,
        ssh_password: None,
        default_mode: None,
    }
}

#[tokio::test]
#[ignore = "needs WSL + hermes acp"]
async fn probe_reports_agent_identity() {
    let dto = wsl_profile("hermes", &["acp"]);
    let profile = to_profile(&dto).expect("convert");
    let (proc, _incoming, outcome) = initialize(&profile, &dto.cwd, Duration::from_secs(20))
        .await
        .expect("handshake 应当成功");
    println!(
        "agent = {} {} · protocol v{}",
        outcome.agent_name, outcome.agent_version, outcome.protocol_version
    );
    assert!(
        outcome.agent_name.to_lowercase().contains("hermes"),
        "应当报出 hermes 的 agentInfo，实际 {}",
        outcome.agent_name
    );
    assert!(!outcome.agent_version.is_empty(), "版本号不该为空");
    assert_eq!(outcome.protocol_version, 1, "当前 ACP 协议版本是 1");
    // 协议能力必须从握手里读出来，界面才有东西显示（以前这里只有一张 hermes CLI 硬编码表）
    println!("capabilities = {:?}", outcome.capabilities);
    assert!(
        !outcome.capabilities.is_empty(),
        "hermes 应当报上来至少一项协议能力"
    );
    assert!(
        outcome.capabilities.iter().any(|c| c == "loadSession"),
        "hermes 支持 loadSession，应当出现在能力列表里"
    );
    proc.kill().await;
}

#[tokio::test]
#[ignore = "needs WSL; 起一个不存在的命令"]
async fn probe_fails_for_missing_program() {
    let dto = wsl_profile("definitely-not-an-acp-agent", &["acp"]);
    let profile = to_profile(&dto).expect("convert");
    let started = initialize(&profile, &dto.cwd, Duration::from_secs(20)).await;
    assert!(
        started.is_err(),
        "不存在的命令必须报错（否则设置页会给假绿灯）"
    );
    println!(
        "预期的失败：{}",
        started.err().map(|e| e.to_string()).unwrap_or_default()
    );
}
