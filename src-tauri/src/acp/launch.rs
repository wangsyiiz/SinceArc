//! 进程启动的三种形态：本地直连 / 经 wsl.exe 中转 / 经 ssh。
//!
//! 路径语义提醒：`cwd` 属于 agent 所在的世界 —— WSL 与 SSH 场景是 `/home/...`，
//! 本地场景是 `C:\...`。这里只负责把它交给正确的启动器，
//! 不负责把它翻译成另一侧的形式（那是 fs 层 `FsProvider` 的事）。
//!
//! SSH 的两条硬约束（都来自实测）：
//! - 必须 `-T`：开 PTY 会加 CRLF 与回显，直接破坏 JSON-RPC 的按行分帧；
//! - 远端命令必须 `exec`：少一层 shell，pid 才对得上；真正的清理不靠断开 ssh
//!   （setsid 之后 SIGHUP 也不能保证传到），而是 kill_tree 在同一侧按进程组杀。

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

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

/// 杀死一棵进程树时要执行的东西。
///
/// 本机直起时由 `transport` 按平台处理（Windows = taskkill，Unix = 进程组）；
/// WSL/SSH 则把「同侧的 relay 命令」预先算好，kill 时原样执行 ——
/// 远端进程必须在远端杀，不能靠杀本地的 wsl.exe / ssh.exe 碰运气。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KillTarget {
    Local,
    Remote {
        /// 日志里的方式名：wsl / ssh
        kind: &'static str,
        program: String,
        args: Vec<String>,
        env: BTreeMap<String, String>,
        /// 本次启动的 uuid（只允许 [a-z0-9-]）
        id: String,
        pid_file: String,
    },
}

/// `wsl.exe` / `ssh.exe` 用绝对路径：从资源管理器或 IDE 启动的 GUI 进程，
/// PATH 里不一定有 System32，靠名字解析会 spawn 失败（表现为 50200）。
pub(crate) fn system_tool(name: &str) -> String {
    #[cfg(windows)]
    {
        if let Ok(root) = std::env::var("SystemRoot") {
            let p = std::path::Path::new(&root).join("System32").join(name);
            if p.exists() {
                return p.to_string_lossy().to_string();
            }
        }
    }
    name.to_string()
}

/// 最终要交给 `tokio::process::Command` 的东西。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnSpec {
    pub program: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    /// askpass 之类的临时文件，进程结束后删除
    pub cleanup: Option<PathBuf>,
    /// 远端 pid 文件（WSL / SSH）：setsid 里的 shell 在 exec 前把 $$ 写进去，
    /// exec 不改 pid，所以它就是 agent 的 pid / pgid。断连后靠它判断有没有残留 ——
    /// 靠 `ps | grep 'hermes acp'` 是不行的：hermes 是 python 入口，
    /// argv 里根本没有 "hermes acp" 这个子串。
    pub pid_file: Option<String>,
    /// 本次启动的短 uuid，日志与远端临时文件名都用它
    pub agent_id: String,
    /// kill_tree 要执行的回收方式
    pub kill: KillTarget,
}

/// 把「真的会执行的东西」渲染成一条人能读、能粘贴的命令行。
/// 必须在 `command_line()` 的产物上渲染，不许另写一套拼装。
pub fn render_command_line(spec: &SpawnSpec) -> String {
    let mut line = quote_arg(&spec.program);
    for arg in &spec.args {
        line.push(' ');
        line.push_str(&quote_arg(arg));
    }
    line
}

/// 需要时用双引号包住参数，并转义 shell 会解释的字符。
///
/// 换行属于空白字符，会被一起包进双引号并原样保留 —— 改成字面量 `\n`
/// 会改变参数内容，不再是「可粘贴」的同一条命令。
fn quote_arg(arg: &str) -> String {
    let needs_quotes = arg.is_empty()
        || arg
            .chars()
            .any(|c| c.is_whitespace() || matches!(c, '"' | '\'' | '$' | '`'));
    if !needs_quotes {
        return arg.to_string();
    }

    let mut quoted = String::with_capacity(arg.len() + 2);
    quoted.push('"');
    for c in arg.chars() {
        match c {
            '"' => quoted.push_str("\\\""),
            '$' => quoted.push_str("\\$"),
            '`' => quoted.push_str("\\`"),
            _ => quoted.push(c),
        }
    }
    quoted.push('"');
    quoted
}

#[derive(Debug)]
pub enum LaunchError {
    Io(std::io::Error),
    InvalidAgentId(String),
}

impl std::fmt::Display for LaunchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "launch preparation failed: {e}"),
            Self::InvalidAgentId(id) => write!(f, "invalid agent id for remote cleanup: {id}"),
        }
    }
}

static AGENT_ID_SEQ: AtomicU64 = AtomicU64::new(1);

/// 生成短 uuid。不引 `uuid` 依赖：进程 id + 纳秒 + 递增序号已经足够唯一，
/// 而且天然只含 `[a-z0-9-]`，可以直接拼进 shell 命令。
fn next_agent_id() -> String {
    let seq = AGENT_ID_SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}-{:x}-{:x}", std::process::id(), nanos, seq)
}

/// uuid 会原样拼进远端 shell 命令，必须只允许 `[a-z0-9-]`。
pub(crate) fn valid_agent_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 96
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
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
        let agent_id = next_agent_id();
        if !valid_agent_id(&agent_id) {
            return Err(LaunchError::InvalidAgentId(agent_id));
        }
        let pid_file = match &self.launch {
            Launch::Local => None,
            _ => Some(format!("/tmp/sincearc-{agent_id}.pid")),
        };
        let marker_file = pid_file
            .as_ref()
            .map(|f| f.replace(".pid", ".nosetsid"));

        let (program, args, kill) = match &self.launch {
            Launch::Local => (
                self.program.clone(),
                self.args.clone(),
                KillTarget::Local,
            ),
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
                // 显式补上；setsid 让远端 shell 成为新会话首进程，pid == pgid，
                // 之后 `kill -TERM -<pid>` 才能带走整棵树。
                let pid = pid_file.as_deref().expect("wsl always records pid");
                let marker = marker_file.as_deref().expect("wsl always records marker");
                argv.push(transport_script(
                    &format!(
                        "export PATH=\"$HOME/.local/bin:$HOME/.cargo/bin:$PATH\"; {}",
                        guarded_exec(&self.program, &self.args, pid, marker)
                    ),
                    &agent_id,
                ));

                let kill_script = remote_kill_script(&agent_id, pid, marker)?;
                let kill = KillTarget::Remote {
                    kind: "wsl",
                    program: system_tool("wsl.exe"),
                    args: vec![
                        "-d".to_string(),
                        distro.clone(),
                        "--".to_string(),
                        "bash".to_string(),
                        "-lc".to_string(),
                        transport_script(&kill_script, &format!("{agent_id}-kill")),
                    ],
                    env: BTreeMap::from([("WSL_UTF8".to_string(), "1".to_string())]),
                    id: agent_id.clone(),
                    pid_file: pid.to_string(),
                };
                (system_tool("wsl.exe"), argv, kill)
            }
            Launch::Ssh(spec) => {
                let mut argv = ssh_common_args(spec, &mut env, &mut cleanup)?;
                let mut kill_args = argv.clone();
                let pid = pid_file.as_deref().expect("ssh always records pid");
                let marker = marker_file.as_deref().expect("ssh always records marker");
                argv.push(transport_script(
                    &remote_command(&self.program, &self.args, cwd, pid, marker),
                    &agent_id,
                ));

                kill_args.push(transport_script(
                    &remote_kill_script(&agent_id, pid, marker)?,
                    &format!("{agent_id}-kill"),
                ));
                let kill = KillTarget::Remote {
                    kind: "ssh",
                    program: system_tool("ssh.exe"),
                    args: kill_args,
                    env: env.clone(),
                    id: agent_id.clone(),
                    pid_file: pid.to_string(),
                };
                (system_tool("ssh.exe"), argv, kill)
            }
        };

        Ok(SpawnSpec {
            program,
            args,
            env,
            cleanup,
            pid_file,
            agent_id,
            kill,
        })
    }
}

/// SSH 的公共参数：连接目标、认证方式、`--` 与服务端命令前缀。
fn ssh_common_args(
    spec: &SshSpec,
    env: &mut BTreeMap<String, String>,
    cleanup: &mut Option<PathBuf>,
) -> Result<Vec<String>, LaunchError> {
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
            *cleanup = Some(path);
        }
    }

    argv.push("--".into());
    argv.push(format!("{}@{}", spec.user, spec.host));
    Ok(argv)
}

/// 远端要执行的整条命令：先 cd（失败就整条失败），再在 setsid 里 exec 顶替内层 shell。
///
/// **relay 进程绝不能变成 setsid 本身**（2026-10-24 实测，两个入口都要堵）：
/// `exec setsid …` 会让 relay 被替换、立刻退出；而**末尾只有 if 也会** —— sh/zsh 会把命令行里
/// 最后一个命令优化成 exec，于是 if 里的 setsid 同样顶掉 relay。setsid 在调用者是进程组长时
/// 会 fork、父进程返回，relay 一退 `wsl.exe` 就认为会话结束、把管道收掉：我们这边看到
/// `handshake failed: agent closed stdout`（界面 50200），agent 其实起来了，只是 stdout 没人接。
/// 所以：① setsid 前不写 exec；② 末尾补 `; exit $?`。
/// 新会话首进程仍是 pid 文件里的 `$$`，`kill -TERM -<pid>` 照样整组回收；
/// agent 退出后 relay 的 wait 返回，`exit $?` 把退出码带回去。
fn remote_command(
    program: &str,
    args: &[String],
    cwd: &str,
    pid_file: &str,
    marker_file: &str,
) -> String {
    let mut cmd = String::new();
    if !cwd.is_empty() {
        cmd.push_str("cd ");
        cmd.push_str(&shell_quote(cwd));
        cmd.push_str(" && { ");
    }
    // 非交互 ssh 会话不读 ~/.zshrc，PATH 里没有 ~/.local/bin（hermes 就装在那儿）。
    cmd.push_str("export PATH=\"$HOME/.local/bin:$HOME/.cargo/bin:$PATH\"; ");
    cmd.push_str(&guarded_exec(program, args, pid_file, marker_file));
    if !cwd.is_empty() {
        cmd.push_str("; }");
    }
    cmd
}

/// 远端脚本的传输：base64 → 落地成临时文件 → `exec bash <file>`。
///
/// 为什么不把脚本直接拼进命令行：`wsl.exe` / `ssh.exe` 只把参数用空格拼成一条命令行，
/// **单引号过这一层会被吃掉**（实测 `wsl.exe -d fedora -- bash -lc "echo '$HOME'"`
/// 输出 `/home/jerry`），脚本随即被 relay 的 shell 重新解析一遍：
/// `$$` 变成 relay 自己的 pid、`"$old_umask"` 提前展开。
/// 后果不是报错而是**错得刚刚好**：pid 文件里记的是 relay，`kill -TERM -<pid>`
/// 只杀 relay，agent 换个会话留在机器上。base64 字母表里没有空格和引号，
/// 原样穿过这一层；脚本落地后由 bash 从文件读，stdin 仍然留给 ACP 的 JSON-RPC 流。
pub(crate) fn transport_script(script: &str, id: &str) -> String {
    let file = format!("/tmp/sincearc-{id}.sh");
    format!(
        "echo {} | base64 -d > {file}; test -s {file} || {{ echo sincearc-decode-failed >&2; exit 97; }}; exec bash {file}",
        base64_of(script)
    )
}

fn base64_of(text: &str) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(text.len().div_ceil(3) * 4);
    for chunk in text.as_bytes().chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

/// 在远端把 agent 放进新会话，并在 exec 前把 `$$` 写进 pid 文件。
///
/// `setsid` 不存在时不能假装干净：写一个 marker 让 kill 侧明确降级为
/// 「只杀直接子进程」，并把原因报到界面。
pub(crate) fn guarded_exec(
    program: &str,
    args: &[String],
    pid_file: &str,
    marker_file: &str,
) -> String {
    let exec = command_words(program, args);
    let inner = format!(
        "old_umask=$(umask); umask 077; echo $$ > {}; umask \"$old_umask\"; exec {exec}",
        shell_quote(pid_file)
    );
    format!(
        "if command -v setsid >/dev/null 2>&1; then setsid sh -c {}; \
         else echo {} >&2; old_umask=$(umask); umask 077; echo $$ > {}; : > {}; umask \"$old_umask\"; exec {exec}; fi; exit $?",
        shell_quote(&inner),
        shell_quote("sincearc: setsid not found; process-tree cleanup degraded"),
        shell_quote(pid_file),
        shell_quote(marker_file),
    )
}

/// 远端回收脚本。与启动脚本约定同一个 pid / marker 文件。
///
/// 正常路径杀整个进程组；marker 存在（启动时没 setsid）时只杀直接子进程，
/// 并显式输出 `SINCEARC_DEGRADED`，调用方据此提示「可能残留」。
pub(crate) fn remote_kill_script(
    id: &str,
    pid_file: &str,
    marker_file: &str,
) -> Result<String, LaunchError> {
    if !valid_agent_id(id) {
        return Err(LaunchError::InvalidAgentId(id.to_string()));
    }
    let pidfile = shell_quote(pid_file);
    let marker = shell_quote(marker_file);
    Ok(format!(
        "pidfile={pidfile}; marker={marker}; \
         if [ ! -s \"$pidfile\" ]; then echo SINCEARC_NO_PID; rm -f \"$pidfile\" \"$marker\"; exit 4; fi; \
         pid=$(cat \"$pidfile\"); \
         case \"$pid\" in ''|*[!0-9]*) echo SINCEARC_BAD_PID; rm -f \"$pidfile\" \"$marker\"; exit 5;; esac; \
         if [ \"$pid\" -le 1 ] 2>/dev/null; then echo SINCEARC_BAD_PID; rm -f \"$pidfile\" \"$marker\"; exit 5; fi; \
         degraded=0; \
         if [ -f \"$marker\" ]; then degraded=1; echo \"SINCEARC_TERM $pid direct\"; kill -TERM \"$pid\" 2>/dev/null; \
         elif kill -0 -\"$pid\" 2>/dev/null; then \
           if kill -TERM -\"$pid\" 2>/dev/null; then echo \"SINCEARC_TERM $pid group\"; \
           else degraded=1; echo \"SINCEARC_TERM $pid direct-fallback\"; kill -TERM \"$pid\" 2>/dev/null; fi; \
         else echo \"SINCEARC_TERM $pid skipped\"; fi; \
         sleep 2; \
         if [ \"$degraded\" = 1 ]; then \
           if kill -0 \"$pid\" 2>/dev/null; then echo \"SINCEARC_KILL $pid direct\"; kill -KILL \"$pid\" 2>/dev/null; \
           else echo \"SINCEARC_KILL $pid skipped\"; fi; \
         else \
           if kill -0 -\"$pid\" 2>/dev/null; then echo \"SINCEARC_KILL $pid group\"; kill -KILL -\"$pid\" 2>/dev/null; \
           else echo \"SINCEARC_KILL $pid skipped\"; fi; \
         fi; \
         alive=0; \
         if [ \"$degraded\" = 1 ]; then kill -0 \"$pid\" 2>/dev/null && alive=1; \
         else kill -0 -\"$pid\" 2>/dev/null && alive=1; fi; \
         rm -f \"$pidfile\" \"$marker\"; \
         if [ \"$degraded\" = 1 ]; then echo SINCEARC_DEGRADED; exit 3; fi; \
         if [ \"$alive\" = 1 ]; then echo SINCEARC_STILL_ALIVE; exit 6; fi; \
         echo SINCEARC_KILLED; exit 0"
    ))
}

fn command_words(program: &str, args: &[String]) -> String {
    // program 沿用旧行为按原样拼（通常是 hermes / node 这类单 token），
    // args 逐个 shell_quote，避免参数里的空格与元字符改变命令含义。
    let mut out = program.to_string();
    for a in args {
        out.push(' ');
        out.push_str(&shell_quote(a));
    }
    out
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

        assert!(spec.program.ends_with("wsl.exe"), "got: {}", spec.program);
        assert_eq!(spec.args[0..2], ["-d", "fedora"]);
        assert!(spec.args.contains(&"--cd".to_string()));
        assert!(spec.args.contains(&"/home/jerry/src".to_string()));

        let arg = spec.args.last().expect("script is last arg");
        assert_transport_safe(arg);
        let script = decode_transport(arg);
        // login shell 的 PATH 不含 ~/.local/bin，必须显式补
        assert!(script.contains("$HOME/.local/bin"), "got: {script}");
        // setsid 让 pid == pgid；pid 文件是后续整组回收的依据
        assert!(script.contains("command -v setsid"), "got: {script}");
        // 有意不写 exec：exec 会让 relay 先退出，wsl.exe 收掉管道（agent closed stdout）
        assert!(script.contains("then setsid sh -c"), "got: {script}");
        assert!(!script.contains("exec setsid"), "exec setsid 会把 relay 顶掉，别再写回去");
        assert!(script.contains("/tmp/sincearc-"), "got: {script}");
        assert!(script.contains("exec hermes"), "got: {script}");
        assert!(script.contains("acp"), "got: {script}");
        assert!(matches!(spec.kill, KillTarget::Remote { kind: "wsl", .. }));
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

        assert!(spec.program.ends_with("ssh.exe"), "got: {}", spec.program);
        // 不能有 PTY
        assert_eq!(spec.args[0], "-T");
        assert!(spec.args.windows(2).any(|w| w == ["-p", "2222"]));
        assert!(spec.args.contains(&"BatchMode=yes".to_string()));
        assert!(spec.args.contains(&"IdentitiesOnly=yes".to_string()));

        assert_eq!(spec.args[spec.args.len() - 2], "root@example.com");
        let arg = spec.args.last().unwrap();
        assert_transport_safe(arg);
        let remote = decode_transport(arg);
        // cd、setsid、pid 记账、exec 都在；kill 时同一条 ssh 参数还能复用
        assert!(
            remote.starts_with("cd '/srv/app' && { export PATH="),
            "got: {remote:?}"
        );
        // 不加 exec：exec 会让 relay 先退出，wsl.exe 收掉管道（agent closed stdout）
        assert!(remote.contains("then setsid sh -c"), "got: {remote:?}");
        assert!(remote.contains("exec hermes"), "got: {remote:?}");
        assert!(remote.contains("acp"), "got: {remote:?}");
        assert!(matches!(spec.kill, KillTarget::Remote { kind: "ssh", .. }));
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
        let cmd = remote_command(
            "hermes",
            &["acp".into()],
            "",
            "/tmp/sincearc-x.pid",
            "/tmp/sincearc-x.nosetsid",
        );
        assert!(cmd.starts_with("export PATH=\"$HOME/.local/bin:$HOME/.cargo/bin:$PATH\"; "));
        assert!(cmd.contains("then setsid sh -c"));
        assert!(!cmd.contains("exec setsid"), "exec setsid 会把 relay 顶掉");
        assert!(cmd.contains("exec hermes"));
        assert!(cmd.contains("acp"));
    }

    /// 命令行过 `wsl.exe` / `ssh.exe` 这一层时引号会被吃掉（实测：`bash -lc "echo '$HOME'"`
    /// 输出 `/home/jerry`），脚本会被 relay 的 shell 重新解析。所以传输的脚本只能是
    /// base64 + 不含引号/`$` 的固定包装 —— 这条断言就是那道闸。
    fn assert_transport_safe(arg: &str) {
        assert!(
            arg.starts_with("echo ") && arg.contains(" | base64 -d > /tmp/sincearc-"),
            "got: {arg}"
        );
        for bad in ['\'', '"', '$'] {
            assert!(!arg.contains(bad), "传输命令行里不允许出现 {bad:?}：{arg}");
        }
    }

    fn decode_transport(arg: &str) -> String {
        const TABLE: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let b64 = arg.split_whitespace().nth(1).expect("base64 跟在 echo 后面");
        let mut bits = 0u32;
        let mut nbits = 0;
        let mut out = Vec::new();
        for ch in b64.bytes() {
            if ch == b'=' {
                break;
            }
            let v = TABLE.find(ch as char).expect("base64 字符") as u32;
            bits = (bits << 6) | v;
            nbits += 6;
            if nbits >= 8 {
                nbits -= 8;
                out.push((bits >> nbits) as u8);
                bits &= (1 << nbits) - 1;
            }
        }
        String::from_utf8(out).expect("utf-8")
    }

    #[test]
    fn base64_matches_reference_vectors() {
        assert_eq!(base64_of(""), "");
        assert_eq!(base64_of("a"), "YQ==");
        assert_eq!(base64_of("ab"), "YWI=");
        assert_eq!(base64_of("hello"), "aGVsbG8=");
        assert_eq!(base64_of("中文"), "5Lit5paH");
    }

    #[test]
    fn transport_wrapper_keeps_script_out_of_the_command_line() {
        let script = "echo 'x' && echo \"$HOME\"; echo $$";
        let cmd = transport_script(script, "abc-1");
        assert_transport_safe(&cmd);
        assert!(cmd.contains("/tmp/sincearc-abc-1.sh"), "got: {cmd}");
        assert!(cmd.ends_with("exec bash /tmp/sincearc-abc-1.sh"), "got: {cmd}");
        assert_eq!(decode_transport(&cmd), script);
    }

    fn bare_spec(program: &str, args: &[&str]) -> SpawnSpec {
        SpawnSpec {
            program: program.into(),
            args: args.iter().map(|s| (*s).to_string()).collect(),
            env: BTreeMap::new(),
            cleanup: None,
            pid_file: None,
            agent_id: "test-1".into(),
            kill: KillTarget::Local,
        }
    }

    #[test]
    fn agent_id_only_allows_shell_safe_characters() {
        assert!(valid_agent_id("abc-123"));
        assert!(!valid_agent_id("abc;rm -rf /"));
        assert!(!valid_agent_id("ABC"));
        assert!(remote_kill_script("bad;id", "/tmp/x.pid", "/tmp/x.nosetsid").is_err());
        let script = remote_kill_script("ok-123", "/tmp/x.pid", "/tmp/x.nosetsid").unwrap();
        assert!(script.contains("kill -0 -\"$pid\""));
        assert!(script.contains("kill -TERM -\"$pid\""));
        assert!(script.contains("kill -KILL -\"$pid\""));
        assert!(script.contains("SINCEARC_KILL $pid skipped"));
        assert!(script.contains("SINCEARC_STILL_ALIVE"));
        assert!(script.contains("SINCEARC_DEGRADED"));
    }

    #[test]
    fn render_local_lists_program_and_args() {
        assert_eq!(
            render_command_line(&bare_spec("hermes", &["acp"])),
            "hermes acp"
        );
    }

    #[test]
    fn render_quotes_args_with_spaces() {
        let line = render_command_line(&bare_spec("hermes", &["a b"]));
        assert!(line.contains("\"a b\""), "got: {line}");
    }

    #[test]
    fn render_wsl_keeps_cd_and_shell() {
        let spec = profile(Launch::Wsl {
            distro: "fedora".into(),
            shell: "zsh".into(),
        })
        .command_line("/home/jerry/src")
        .unwrap();
        let line = render_command_line(&spec);
        assert!(line.contains("wsl.exe"), "got: {line}");
        assert!(line.contains(" -d "), "got: {line}");
        assert!(line.contains(" --cd "), "got: {line}");
        assert!(line.contains(" -lc "), "got: {line}");
    }

    #[test]
    fn render_does_not_leak_env_or_pidfile() {
        let mut spec = bare_spec("hermes", &["acp"]);
        spec.env.insert("SINCEARC_X".into(), "1".into());
        spec.pid_file = Some("/tmp/sincearc-internal.pid".into());
        let line = render_command_line(&spec);
        assert!(!line.contains("SINCEARC_X"), "got: {line}");
        assert!(!line.contains("sincearc-internal.pid"), "got: {line}");
    }
}
