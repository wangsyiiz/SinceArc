//! 诊断：`50200` 是「启动或握手失败」的兜底码，它盖住了「ssh 没填 host」「cwd 是空串」
//! 「命令不在 PATH 上」这些完全不同的原因。这个测试把常见配置各跑一遍，打印真实错误，
//! 用来决定该在哪一层拦（不是断言测试，跑完看输出）。
//!
//! cargo test --test probe_diagnostics -- --ignored --nocapture --test-threads=1

use std::time::Duration;

use sincearc_lib::acp::initialize;
use sincearc_lib::commands::{to_profile, ProfileDto};

fn profile(
    id: &str,
    launch: &str,
    program: &str,
    args: &[&str],
    cwd: &str,
    distro: Option<&str>,
    ssh_host: Option<&str>,
) -> ProfileDto {
    ProfileDto {
        id: id.into(),
        name: id.into(),
        launch: launch.into(),
        program: program.into(),
        args: args.iter().map(|s| s.to_string()).collect(),
        cwd: cwd.into(),
        distro: distro.map(str::to_string),
        shell: Some("zsh".into()),
        ssh_host: ssh_host.map(str::to_string),
        ssh_port: Some(22),
        ssh_user: None,
        ssh_auth: None,
        ssh_key_path: None,
        ssh_password: None,
        default_mode: None,
    }
}

#[tokio::test]
#[ignore = "diagnostic; prints real errors"]
async fn which_configurations_produce_50200() {
    let cases = vec![
        (
            "wsl + hermes + 正常 cwd（基线，应当成功）",
            profile(
                "a",
                "wsl",
                "hermes",
                &["acp"],
                "/home/jerry/source",
                Some("fedora"),
                None,
            ),
        ),
        (
            "wsl + hermes + 空 cwd（新建 profile 的默认值）",
            profile("b", "wsl", "hermes", &["acp"], "", Some("fedora"), None),
        ),
        (
            "wsl + npx 预设（Gemini）",
            profile(
                "c",
                "wsl",
                "npx",
                &["-y", "@google/gemini-cli@0.65.0", "--acp"],
                "/home/jerry/source",
                Some("fedora"),
                None,
            ),
        ),
        (
            "wsl + codex-acp（看它 agentInfo.name 到底是什么）",
            profile(
                "g",
                "wsl",
                "npx",
                &["-y", "@agentclientprotocol/codex-acp@2.2.2"],
                "/home/jerry/source",
                Some("fedora"),
                None,
            ),
        ),
        (
            "wsl + 不存在的程序",
            profile(
                "d",
                "wsl",
                "no-such-agent",
                &["acp"],
                "/home/jerry/source",
                Some("fedora"),
                None,
            ),
        ),
        (
            "ssh + 没填 host（新建 profile 的默认 launch 是 ssh）",
            profile("e", "ssh", "hermes", &["acp"], "/home/jerry", None, None),
        ),
        (
            "local + hermes（Windows 侧没有这个二进制）",
            profile("f", "local", "hermes", &["acp"], "C:\\source", None, None),
        ),
    ];

    for (label, dto) in cases {
        let parsed = match to_profile(&dto) {
            Ok(p) => p,
            Err(e) => {
                println!("[{}] to_profile 就失败: {} {}", label, e.code, e.msg);
                continue;
            }
        };
        match initialize(&parsed, &dto.cwd, Duration::from_secs(20)).await {
            Ok((proc, _rx, out)) => {
                println!("[{}] OK -> {} {}", label, out.agent_name, out.agent_version);
                proc.kill().await;
            }
            Err(e) => println!("[{}] FAIL -> {}", label, e),
        }
    }
}
