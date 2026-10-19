//! 进程启动的两种形态：本地直连 / 经 wsl.exe 中转。
//!
//! 路径语义提醒：`cwd` 属于 agent 所在的世界 —— WSL 场景是 `/home/...`，
//! 本地场景是 `C:\...`。这里只负责把它交给正确的启动器，
//! 不负责把它翻译成另一侧的形式（那是 fs 层 `FsProvider` 的事）。

use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Launch {
    Local,
    Wsl { distro: String, shell: String },
}

#[derive(Debug, Clone)]
pub struct AgentProfile {
    pub id: String,
    pub name: String,
    pub launch: Launch,
    pub program: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    /// 语义随 launch 变：WSL 内路径或 Windows 路径
    pub default_cwd: PathBuf,
}

impl AgentProfile {
    /// 返回 (可执行文件, 参数表)，留给 E1 接 tokio::process。
    pub fn command_line(&self, cwd: &str) -> (String, Vec<String>) {
        match &self.launch {
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
                let mut cmd = self.program.clone();
                if !self.args.is_empty() {
                    cmd.push(' ');
                    cmd.push_str(&self.args.join(" "));
                }
                argv.push(cmd);
                ("wsl.exe".to_string(), argv)
            }
        }
    }
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
        let (prog, args) = profile(Launch::Local).command_line("C:/x");
        assert_eq!(prog, "hermes");
        assert_eq!(args, vec!["acp"]);
    }

    #[test]
    fn wsl_launch_goes_through_relay_with_login_shell() {
        let (prog, args) = profile(Launch::Wsl {
            distro: "fedora".into(),
            shell: "zsh".into(),
        })
        .command_line("/home/jerry/src");

        assert_eq!(prog, "wsl.exe");
        assert_eq!(args[0..2], ["-d", "fedora"]);
        assert!(args.contains(&"--cd".to_string()));
        assert!(args.contains(&"/home/jerry/src".to_string()));
        assert_eq!(args.last().unwrap(), "hermes acp");
    }
}
