//! SSH 断连后，远端 agent 会退出吗？
//!
//! WSL 已实测（`remote_cleanup.rs`）。SSH 多一层 sshd，kill_tree 会在远端
//! 按 setsid 进程组回收；这里真连一次验证。
//!
//! 需要 `SINCEARC_SSH_PASSWORD`（走密码档）。

use std::time::Duration;

use sincearc_lib::acp::initialize;
use sincearc_lib::commands::{to_profile, ProfileDto};

fn ssh_profile(password: String) -> ProfileDto {
    ProfileDto {
        id: "p-ssh-local".into(),
        name: "WSL over SSH".into(),
        launch: "ssh".into(),
        program: "hermes".into(),
        args: vec!["acp".into()],
        cwd: "/mnt/c/source/sincearc".into(),
        distro: None,
        shell: None,
        ssh_host: Some("localhost".into()),
        ssh_port: Some(22),
        ssh_user: Some("jerry".into()),
        ssh_auth: Some("password".into()),
        ssh_key_path: None,
        ssh_password: Some(password),
        default_mode: None,
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
#[ignore = "needs ssh localhost with password; inspects real processes"]
async fn ssh_disconnect_does_not_leave_an_agent_behind() {
    let password = std::env::var("SINCEARC_SSH_PASSWORD").expect("需要 SINCEARC_SSH_PASSWORD");
    let dto = ssh_profile(password);
    let profile = to_profile(&dto).expect("convert");

    let (proc, _incoming, _outcome) = initialize(&profile, &dto.cwd, Duration::from_secs(120))
        .await
        .expect("ssh handshake");

    let pid_file = proc
        .remote_pid_file()
        .expect("ssh 启动应当记下 pid 文件")
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
    tokio::time::sleep(Duration::from_millis(2000)).await;

    let after = wsl(&format!(
        "kill -0 {pid} 2>/dev/null && echo ALIVE || echo GONE"
    ));
    println!("kill 之后 pid {pid} = {after}");
    let _ = wsl(&format!("rm -f {pid_file}"));

    assert_eq!(after, "GONE", "SSH 断连后远端 agent（pid {pid}）还活着");
}
