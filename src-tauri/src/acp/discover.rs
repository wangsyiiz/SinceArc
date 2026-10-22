//! Agent 发现：找出这台机器上哪些 agent 能当 ACP 服务端跑。
//!
//! 规范见 docs/discovery.md。两件事必须分清：
//! 1. **找人**（这里）：扫 PATH，回答「装没装」；
//! 2. **验证**（agent_probe）：真起一次 initialize，回答「它到底说不说 ACP」。
//!
//! 发现到 `codex` 在 PATH 上不等于能起 ACP —— 实测 `codex --help` 里没有 acp 子命令，
//! 它必须靠 `codex-acp` 适配器。所以候选表带 `mode`，界面上不能糊成一句「已安装」。

use serde::{Deserialize, Serialize};
use std::process::Stdio;
use std::time::Duration;

/// 单条候选：一个「可能能当 ACP 服务端」的 agent。
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct Candidate {
    pub id: &'static str,
    pub name: &'static str,
    /// 判断「装没装」用的命令名
    pub binary: &'static str,
    /// native = CLI 自己说 ACP；adapter = 还需要额外适配器
    pub mode: &'static str,
    /// 真起服务端的命令
    pub acp_program: &'static str,
    pub acp_args: &'static [&'static str],
    pub note: &'static str,
}

/// 候选表：以后加一个 agent 只加一行，不散落在探测代码里（docs/discovery.md §1）。
pub const CANDIDATES: &[Candidate] = &[
    Candidate {
        id: "hermes",
        name: "Hermes Agent",
        binary: "hermes",
        mode: "native",
        acp_program: "hermes",
        acp_args: &["acp"],
        note: "原生 ACP（实测 hermes-agent 0.22.2）",
    },
    Candidate {
        id: "gemini",
        name: "Gemini CLI",
        binary: "gemini",
        mode: "native",
        acp_program: "gemini",
        acp_args: &["--acp"],
        note: "原生 ACP",
    },
    Candidate {
        id: "qwen",
        name: "Qwen Code",
        binary: "qwen",
        mode: "native",
        acp_program: "qwen",
        acp_args: &["--acp", "--experimental-skills"],
        note: "原生 ACP",
    },
    Candidate {
        id: "opencode",
        name: "OpenCode",
        binary: "opencode",
        mode: "native",
        acp_program: "opencode",
        acp_args: &["acp"],
        note: "原生 ACP",
    },
    Candidate {
        id: "goose",
        name: "Goose",
        binary: "goose",
        mode: "native",
        acp_program: "goose",
        acp_args: &["acp"],
        note: "原生 ACP",
    },
    Candidate {
        id: "codex",
        name: "Codex",
        binary: "codex",
        mode: "adapter",
        acp_program: "npx",
        acp_args: &["-y", "@agentclientprotocol/codex-acp"],
        note: "底层 CLI 在也要适配器：实测 codex --help 里没有 acp 子命令",
    },
    Candidate {
        id: "claude",
        name: "Claude Agent",
        binary: "claude",
        mode: "adapter",
        acp_program: "npx",
        acp_args: &["-y", "@agentclientprotocol/claude-agent-acp"],
        note: "Registry 只提供 npx 适配器包",
    },
];

/// 一处命中：在哪个环境、哪条路径。
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct Found {
    pub candidate_id: String,
    /// `local` / `wsl:<distro>` / `ssh:<host>`，界面按它分组
    pub host: String,
    pub path: String,
    /// 该环境下的家目录，用作新建连接的默认工作目录。
    /// 必须是绝对路径：远端命令是 `cd '<cwd>'`，带引号的 `~` 不会被 shell 展开。
    pub home: Option<String>,
}

/// 落库的形态：**只存扫出来的结果**，候选表始终来自代码里的 const。
/// 否则升级版本后缓存里还是旧表，界面上会出现代码里已经不存在的 agent。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryCache {
    pub scanned_at: i64,
    pub found: Vec<Found>,
    /// 扫到了但这些环境本身没起来（比如 wsl.exe 不存在）：要让用户看到，而不是静默少几行
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct DiscoverOutcome {
    #[ts(type = "number")]
    pub scanned_at: i64,
    pub candidates: Vec<Candidate>,
    pub found: Vec<Found>,
    pub warnings: Vec<String>,
}

impl DiscoverOutcome {
    pub fn from_cache(c: DiscoveryCache) -> Self {
        Self {
            scanned_at: c.scanned_at,
            candidates: CANDIDATES.to_vec(),
            found: c.found,
            warnings: c.warnings,
        }
    }

    pub fn into_cache(&self) -> DiscoveryCache {
        DiscoveryCache {
            scanned_at: self.scanned_at,
            found: self.found.clone(),
            warnings: self.warnings.clone(),
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `wsl.exe -l -q` 的发行版列表。输出是 UTF-16 还是 UTF-8 取决于环境，
/// 所以固定加 `WSL_UTF8=1`，再按行取、去掉 `\0` 与 `\r`。
async fn wsl_distros() -> Result<Vec<String>, String> {
    let mut cmd = tokio::process::Command::new(crate::acp::launch::system_tool("wsl.exe"));
    cmd.args(["-l", "-q"])
        .env("WSL_UTF8", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let out = tokio::time::timeout(Duration::from_secs(10), cmd.output())
        .await
        .map_err(|_| "wsl.exe -l -q 超时".to_string())?
        .map_err(|e| format!("wsl.exe -l -q 起不来：{e}"))?;
    if !out.status.success() {
        return Err(format!(
            "wsl.exe -l -q 退出码 {:?}：{}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .replace('\0', "")
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty() && !l.starts_with('*'))
        .collect())
}

/// 一次问完：所有候选命令的路径 + 家目录。
///
/// 为什么不用「每条命令起一次 wsl.exe」：7 条候选 × N 个发行版，每个进程 200–300ms，
/// 加起来就是两三秒的纯等待。一个脚本在同一个 shell 里跑完，只要一次往返。
///
/// 输出格式稳定为 `键<TAB>值` 两种行：
///   `bin:<命令名>\t<绝对路径>`
///   `home\t<家目录>`
pub(crate) fn scan_script() -> String {
    // 两个坑，实测踩过：
    // 1. **不能用 `sh -lc`**：WSL 的 /etc/profile 会把 Windows 的 PATH 拼进来，里面有
    //    `Program Files (x86)`，未加引号 → `syntax error near unexpected token '('`，
    //    脚本后半段整段不执行（表现为「明明装了 agent 却扫出 0 个」）。
    // 2. login shell 也不保证带 ~/.local/bin（hermes / codex 就装在那儿），
    //    所以 PATH 自己拼，不指望环境。
    let mut lines = String::new();
    lines.push_str(
        "export PATH=\"$HOME/.local/bin:$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin:$PATH\"\n",
    );

    for c in CANDIDATES {
        let b = c.binary;
        // login shell 不读 .zshrc，装在 ~/.local/bin 的命令要额外看一眼
        lines.push_str(&format!(
            "p=$(command -v {b} 2>/dev/null); \
if [ -z \"$p\" ] && [ -x \"$HOME/.local/bin/{b}\" ]; then p=\"$HOME/.local/bin/{b}\"; fi; \
[ -n \"$p\" ] && printf 'bin:{b}\t%s\n' \"$p\"; \
"
        ));
    }
    lines.push_str("printf 'home\t%s\n' \"$HOME\"\n");
    lines
}

/// 解析扫描脚本的输出。坏行直接忽略：这是探测，不是协议。
pub(crate) fn parse_scan_output(stdout: &str) -> (Option<String>, Vec<(String, String)>) {
    let mut home = None;
    let mut hits = Vec::new();
    for line in stdout.replace('\0', "").lines() {
        let Some((k, v)) = line.trim().split_once('\t') else {
            continue;
        };
        let v = v.trim();
        if v.is_empty() {
            continue;
        }
        match k.trim() {
            "home" => home = Some(v.to_string()),
            other => {
                if let Some(bin) = other.strip_prefix("bin:") {
                    hits.push((bin.to_string(), v.to_string()));
                }
            }
        }
    }
    (home, hits)
}

/// 在一条环境里找某个命令：返回路径。
async fn find_in_wsl(distro: &str) -> Result<(Option<String>, Vec<(String, String)>), String> {
    use tokio::io::AsyncWriteExt;

    // 脚本从 **stdin** 喂给 `sh -s`，不走 `-c` 参数。
    // 实测：把多行脚本当 `-c` 的单个参数穿过 wsl.exe，`\t` 与 `\"` 会被它的参数转义吃掉，
    // 结果是 `sh` 静默 exit 1、什么都不输出（看起来像「这台机器没装任何 agent」）。
    // 同样的脚本写成文件执行则完全正常 —— 所以问题在参数传递，不在脚本。
    let mut cmd = tokio::process::Command::new(crate::acp::launch::system_tool("wsl.exe"));
    cmd.args(["-d", distro, "--", "sh", "-s"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let mut child = cmd.spawn().map_err(|e| format!("{distro} 起不来：{e}"))?;
    if let Some(mut si) = child.stdin.take() {
        let _ = si.write_all(scan_script().as_bytes()).await;
        // 显式关掉 stdin：sh -s 读到 EOF 才开始跑，不关会一直等
        drop(si);
    }
    let out = tokio::time::timeout(Duration::from_secs(20), child.wait_with_output())
        .await
        .map_err(|_| format!("{distro} 扫描超时"))?
        .map_err(|e| format!("{distro} 扫描失败：{e}"))?;
    Ok(parse_scan_output(&String::from_utf8_lossy(&out.stdout)))
}

/// Windows 本机：`where`（走 cmd 是因为它是 cmd 内建）
async fn find_local(binary: &str) -> Option<String> {
    let mut cmd = tokio::process::Command::new(crate::acp::launch::system_tool("cmd.exe"));
    cmd.args(["/C", "where", binary])
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let out = tokio::time::timeout(Duration::from_secs(10), cmd.output())
        .await
        .ok()?
        .ok()?;
    if !out.status.success() {
        return None;
    }
    first_line(&String::from_utf8_lossy(&out.stdout))
}

fn first_line(s: &str) -> Option<String> {
    s.replace('\0', "")
        .lines()
        .map(|l| l.trim().to_string())
        .find(|l| !l.is_empty())
}

/// 扫一遍：本机 + 每个 WSL 发行版。
pub async fn scan() -> DiscoverOutcome {
    let mut found = Vec::new();
    let mut warnings = Vec::new();

    // 本机
    for c in CANDIDATES {
        if let Some(path) = find_local(c.binary).await {
            found.push(Found {
                candidate_id: c.id.to_string(),
                host: "local".into(),
                path,
                home: std::env::var("USERPROFILE").ok(),
            });
        }
    }

    // WSL：拿不到发行版列表就明说，别让结果看起来「什么都没有」
    match wsl_distros().await {
        Ok(distros) => {
            for d in distros {
                match find_in_wsl(&d).await {
                    Ok((home, hits)) => {
                        for (bin, path) in hits {
                            // 脚本按命令名回报，这里翻回候选 id
                            if let Some(c) = CANDIDATES.iter().find(|c| c.binary == bin) {
                                found.push(Found {
                                    candidate_id: c.id.to_string(),
                                    host: format!("wsl:{d}"),
                                    path,
                                    home: home.clone(),
                                });
                            }
                        }
                    }
                    Err(e) => warnings.push(e),
                }
            }
        }
        Err(e) => warnings.push(format!("WSL 未扫描：{e}")),
    }

    DiscoverOutcome {
        scanned_at: now_ms(),
        candidates: CANDIDATES.to_vec(),
        found,
        warnings,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 解析扫描输出_认得两种行() {
        let out = "bin:hermes\t/home/j/.local/bin/hermes\nbin:codex\t/usr/local/bin/codex\nhome\t/home/j\n";
        let (home, hits) = parse_scan_output(out);
        assert_eq!(home.as_deref(), Some("/home/j"));
        assert_eq!(hits.len(), 2);
        assert_eq!(
            hits[0],
            (
                "hermes".to_string(),
                "/home/j/.local/bin/hermes".to_string()
            )
        );
    }

    #[test]
    fn 解析扫描输出_坏行不影响好行() {
        // 远端 shell 可能打 banner、也可能给空值；探测不该因为一行怪东西就整体失败
        let out = "Welcome to Fedora\r\nbin:gemini\t\n\t\nbin:goose\t/opt/goose\r\n";
        let (home, hits) = parse_scan_output(out);
        assert_eq!(home, None);
        assert_eq!(hits, vec![("goose".to_string(), "/opt/goose".to_string())]);
    }

    #[test]
    fn 扫描脚本覆盖全部候选() {
        let script = scan_script();
        for c in CANDIDATES {
            assert!(script.contains(c.binary), "脚本漏了 {}", c.binary);
        }
        assert!(script.contains("home"));
    }

    #[test]
    fn 候选表没有重复的_binary() {
        for (i, a) in CANDIDATES.iter().enumerate() {
            for b in &CANDIDATES[i + 1..] {
                assert_ne!(a.binary, b.binary, "重复的 binary: {}", a.binary);
            }
        }
    }

    #[test]
    fn 适配器型的候选不能是_原生_acp() {
        for c in CANDIDATES.iter().filter(|c| c.mode == "adapter") {
            // 适配器一定是 npx 起的；如果哪天 codex 原生支持了 acp，这条会红，提醒改表
            assert_eq!(
                c.acp_program, "npx",
                "{} 标了 adapter 却不是 npx 起的",
                c.id
            );
        }
    }
}
