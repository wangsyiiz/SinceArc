//! 断连之后远端还留着 agent 进程吗？
//!
//! `kill_tree()` 现在会在 WSL 同一侧按 setsid 进程组回收；这个测试钉住
//! 真实断连后远端 agent 不残留。
//!
//! 判定不靠 `ps | grep 'hermes acp'`：hermes 是 python 入口，argv 里根本没有
//! 这个子串（实测过，grep 恒空）。改为启动时把远端 shell 的 `$$` 写进 pid 文件，
//! `exec` 不改 pid，所以那就是 agent 的 pid。

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

fn wsl(sh: &str) -> String {
    let out = std::process::Command::new("wsl.exe")
        .args(["-d", "fedora", "--", "sh", "-c", sh])
        .output()
        .expect("run wsl.exe");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

#[tokio::test]
#[ignore = "needs WSL + hermes acp; inspects real processes"]
async fn killing_the_client_should_not_leave_an_agent_behind() {
    let dto = wsl_profile();
    let profile = to_profile(&dto).expect("convert");
    let (proc, _incoming, _outcome) = initialize(&profile, &dto.cwd, Duration::from_secs(60))
        .await
        .expect("handshake");

    let pid_file = proc
        .remote_pid_file()
        .expect("WSL 启动应当记下 pid 文件")
        .to_string();
    let pid = wsl(&format!("cat {pid_file}"));
    println!("agent pid = {pid} (file = {pid_file})");
    assert!(!pid.is_empty(), "pid 文件应当写着远端 shell 的 pid");
    assert_eq!(
        wsl(&format!(
            "kill -0 {pid} 2>/dev/null && echo ALIVE || echo GONE"
        )),
        "ALIVE"
    );

    proc.kill().await;
    tokio::time::sleep(Duration::from_millis(1500)).await;

    let after = wsl(&format!(
        "kill -0 {pid} 2>/dev/null && echo ALIVE || echo GONE"
    ));
    println!("kill 之后 pid {pid} = {after}");
    let _ = wsl(&format!("rm -f {pid_file}"));

    assert_eq!(after, "GONE", "断连后远端 agent（pid {pid}）还活着");
}
