//! 进程启动的三种形态：本地直连 / 经 wsl.exe 中转 / 经 ssh。
//!
//! 路径语义提醒：`cwd` 属于 agent 所在的世界 —— WSL 与 SSH 场景是 `/home/...`，
//! 本地场景是 `C:\...`。这里只负责把它交给正确的启动器，
//! 不负责把它翻译成另一侧的形式（那是 fs 层 `FsProvider` 的事）。
//!
//! SSH 的两条硬约束（都来自实测）：
//! - 必须 `-T`：开 PTY 会加 CRLF 与回显，直接破坏 JSON-RPC 的按行分帧；
//! - 远端命令必须 `exec`：这样杀本地 ssh 客户端时 agent 收到 SIGHUP 直接退出，
//!   否则远端起的是个 shell，bash 默认不把 SIGHUP 传给子进程，agent 会变孤儿。

use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SshAuth {
    Key {
        path: String,
    },
    /// 密码交给 `SSH_ASKPASS`：Windows OpenSSH 支持该机制（本机实测通过），
    /// 但不能同时开 `BatchMode`，否则密码认证整个被禁。
    Password {
        secret: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshSpec {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: SshAuth,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Launch {
    Local,
    Wsl { distro: String, shell: String },
    Ssh(SshSpec),
}

/// 最终要交给 `tokio::process::Command` 的东西。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnSpec {
    pub program: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    /// askpass 之类的临时文件，进程结束后删除
    pub cleanup: Option<PathBuf>,
}

#[derive(Debug)]
pub enum LaunchError {
    Io(std::io::Error),
}

impl std::fmt::Display for LaunchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "launch preparation failed: {e}"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct AgentProfile {
    pub id: String,
    pub name: String,
    pub launch: Launch,
    pub program: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    /// 语义随 launch 变：WSL/SSH 内路径或 Windows 路径
    pub default_cwd: PathBuf,
}

impl AgentProfile {
    /// 生成 (可执行文件, 参数表, 环境变量, 待清理文件)。
    pub fn command_line(&self, cwd: &str) -> Result<SpawnSpec, LaunchError> {
        let mut env = self.env.clone();
        let mut cleanup = None;

        let (program, args) = match &self.launch {
            Launch::Local => (self.program.clone(), self.args.clone()),
            Launch::Wsl { distro, shell } => {
                let mut argv = vec![
                    "-d".to_string(),
                    distro.clone(),
                    "--cd".to_string(),
                    cwd.to_string(),
                    "--".to_string(),
                    shell.clone(),
                    "-lc".to_string(),
                ];
                // login shell 不读 ~/.zshrc，PATH 里没有 ~/.local/bin（hermes 就装在那儿）；
                // 显式补上，并用 exec 让 agent 顶替 shell 进程，pid 才好对得上。
                let mut cmd =
                    String::from("export PATH=\"$HOME/.local/bin:$HOME/.cargo/bin:$PATH\"; exec ");
                cmd.push_str(&self.program);
                if !self.args.is_empty() {
                    cmd.push(' ');
                    cmd.push_str(&self.args.join(" "));
                }
                argv.push(cmd);
                ("wsl.exe".to_string(), argv)
            }
            Launch::Ssh(spec) => {
                let mut argv = vec![
                    "-T".to_string(),
                    "-p".to_string(),
                    spec.port.to_string(),
                    // 首次连接不问人（stdio 没人回答），但记进 known_hosts
                    "-o".to_string(),
                    "StrictHostKeyChecking=accept-new".to_string(),
                ];

                match &spec.auth {
                    SshAuth::Key { path } => {
                        argv.push("-i".into());
                        argv.push(path.clone());
                        argv.push("-o".into());
                        argv.push("IdentitiesOnly=yes".into());
                        // 密钥模式下禁止一切交互提示，连不上就立刻失败
                        argv.push("-o".into());
                        argv.push("BatchMode=yes".into());
                    }
                    SshAuth::Password { secret } => {
                        // 密码认证必须关掉 BatchMode，否则 ssh 直接拒绝走密码；
                        // 同时把尝试次数钉成 1，避免密码错时反复问。
                        argv.push("-o".into());
                        argv.push("NumberOfPasswordPrompts=1".into());
                        argv.push("-o".into());
                        argv.push("PreferredAuthentications=password".into());

                        let (script, path) = write_askpass(secret)?;
                        env.insert("SSH_ASKPASS".into(), script);
                        env.insert("SSH_ASKPASS_REQUIRE".into(), "force".into());
                        cleanup = Some(path);
                    }
                }

                argv.push("--".into());
                argv.push(format!("{}@{}", spec.user, spec.host));

                let remote = remote_command(&self.program, &self.args, cwd);
                argv.push(remote);

                ("ssh.exe".to_string(), argv)
            }
        };

        Ok(SpawnSpec {
            program,
            args,
            env,
            cleanup,
        })
    }
}

/// 远端要执行的整条命令：先 cd（失败就整条失败），再 exec 顶替 shell。
fn remote_command(program: &str, args: &[String], cwd: &str) -> String {
    let mut cmd = String::new();
    if !cwd.is_empty() {
        cmd.push_str("cd ");
        cmd.push_str(&shell_quote(cwd));
        cmd.push_str(" && ");
    }
    // 非交互 ssh 会话不读 ~/.zshrc，PATH 里没有 ~/.local/bin（hermes 就装在那儿）。
    // 用 env 前缀赋值而不是 export：保持 && 链，cd 失败时不会继续 exec。
    cmd.push_str("PATH=\"$HOME/.local/bin:$HOME/.cargo/bin:$PATH\" exec ");
    cmd.push_str(program);
    for a in args {
        cmd.push(' ');
        cmd.push_str(&shell_quote(a));
    }
    cmd
}

/// 远端用 /bin/sh 执行，单引号最省事：内部单引号用 '\'' 断开再拼。
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 写一个 askpass 批处理，内容是回显密码。
///
/// cmd 的 echo 会解释 `%`（变量展开）与 `^ & | < >`（控制符），必须转义；
/// 否则密码里带这些字符时会写错或被截断。
fn write_askpass(secret: &str) -> Result<(String, PathBuf), LaunchError> {
    use std::io::Write;

    let escaped = secret
        .replace('%', "%%")
        .replace('^', "^^")
        .replace('&', "^&")
        .replace('|', "^|")
        .replace('<', "^<")
        .replace('>', "^>");

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!(
        "sincearc-askpass-{}-{nanos}.bat",
        std::process::id()
    ));

    let mut f = std::fs::File::create(&path).map_err(LaunchError::Io)?;
    // CRLF：cmd 对行尾敏感
    write!(f, "@echo off\r\n").map_err(LaunchError::Io)?;
    write!(f, "echo {escaped}\r\n").map_err(LaunchError::Io)?;
    f.flush().map_err(LaunchError::Io)?;

    Ok((path.to_string_lossy().to_string(), path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(launch: Launch) -> AgentProfile {
        AgentProfile {
            id: "p".into(),
            name: "test".into(),
            launch,
            program: "hermes".into(),
            args: vec!["acp".into()],
            env: BTreeMap::new(),
            default_cwd: PathBuf::from("/home/jerry/src"),
        }
    }

    #[test]
    fn local_launch_uses_program_directly() {
        let spec = profile(Launch::Local).command_line("C:/x").unwrap();
        assert_eq!(spec.program, "hermes");
        assert_eq!(spec.args, vec!["acp"]);
        assert!(spec.cleanup.is_none());
    }

    #[test]
    fn wsl_launch_goes_through_relay_with_login_shell() {
        let spec = profile(Launch::Wsl {
            distro: "fedora".into(),
            shell: "zsh".into(),
        })
        .command_line("/home/jerry/src")
        .unwrap();

        assert_eq!(spec.program, "wsl.exe");
        assert_eq!(spec.args[0..2], ["-d", "fedora"]);
        assert!(spec.args.contains(&"--cd".to_string()));
        assert!(spec.args.contains(&"/home/jerry/src".to_string()));

        let script = spec.args.last().expect("script is last arg");
        // login shell 的 PATH 不含 ~/.local/bin，必须显式补
        assert!(script.contains("$HOME/.local/bin"));
        // 用 exec 顶替 shell，pid 才对得上
        assert!(script.ends_with("exec hermes acp"), "got: {script}");
    }

    #[test]
    fn ssh_with_key_disables_interaction_and_execs_remotely() {
        let spec = profile(Launch::Ssh(SshSpec {
            host: "example.com".into(),
            port: 2222,
            user: "root".into(),
            auth: SshAuth::Key {
                path: "C:/k/id".into(),
            },
        }))
        .command_line("/srv/app")
        .unwrap();

        assert_eq!(spec.program, "ssh.exe");
        // 不能有 PTY
        assert_eq!(spec.args[0], "-T");
        assert!(spec.args.windows(2).any(|w| w == ["-p", "2222"]));
        assert!(spec.args.contains(&"BatchMode=yes".to_string()));
        assert!(spec.args.contains(&"IdentitiesOnly=yes".to_string()));

        assert_eq!(spec.args[spec.args.len() - 2], "root@example.com");
        let remote = spec.args.last().unwrap();
        // cd 与 exec 都在，且 exec 让 SIGHUP 直达 agent
        assert!(
            remote.starts_with("cd '/srv/app' && PATH=\"$HOME/.local/bin"),
            "got: {remote:?}"
        );
        assert!(remote.ends_with("exec hermes 'acp'"), "got: {remote:?}");
        assert!(spec.cleanup.is_none());
    }

    #[test]
    fn ssh_with_password_uses_askpass_and_never_batch_mode() {
        let spec = profile(Launch::Ssh(SshSpec {
            host: "localhost".into(),
            port: 22,
            user: "jerry".into(),
            auth: SshAuth::Password {
                secret: "pa%ss&word".into(),
            },
        }))
        .command_line("/home/jerry")
        .unwrap();

        assert_eq!(
            spec.env.get("SSH_ASKPASS_REQUIRE").map(String::as_str),
            Some("force")
        );
        assert!(spec.env.contains_key("SSH_ASKPASS"));
        // BatchMode 会禁掉密码认证，绝不能出现
        assert!(!spec.args.contains(&"BatchMode=yes".to_string()));
        assert!(spec.args.contains(&"NumberOfPasswordPrompts=1".to_string()));

        let path = spec.cleanup.expect("askpass 临时文件要登记，进程结束后删");
        let body = std::fs::read_to_string(&path).unwrap();
        // % 与 & 必须转义，否则 cmd 会截断或展开
        assert!(body.contains("pa%%ss^&word"), "got: {body}");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn remote_command_without_cwd_skips_cd() {
        assert_eq!(
            remote_command("hermes", &["acp".into()], ""),
            "PATH=\"$HOME/.local/bin:$HOME/.cargo/bin:$PATH\" exec hermes 'acp'"
        );
    }
}
