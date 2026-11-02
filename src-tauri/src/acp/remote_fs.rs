//! 远端目录浏览：在连接的**同一侧**跑一条短脚本，列出某一层的子目录。
//!
//! 只服务 WSL / SSH 连接（docs/desktop-ux.md §45）：这两种的工作目录是远端路径，
//! Windows 的系统目录选择器够不到。本地连接走 `pick_directory`（rfd），不进这里。
//!
//! 三个刻意的选择：
//! 1. **脚本走 stdin**（`bash -s`），不拼进命令行参数。discover.rs 里记过这个坑：
//!    多行脚本当 `wsl.exe -c` 的单个参数时，`\t`、`\"` 会被参数转义吃掉，sh 静默 exit 1。
//! 2. **不用 `-lc`**：login shell 会把 Windows 的 PATH 拼进来，目录名带 `(` 就会炸。
//! 3. 超时短（8 秒）：用户正开着弹窗等，卡住不如直接报错。
//!
//! 这里不起 agent、也不碰 `SpawnSpec` 的 pid/kill 语义 —— 那套是给长生命周期进程用的。

use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::process::{Child, Command};

use super::launch::{AgentProfile, Launch};

/// 一次列目录的超时。
const LIST_TIMEOUT: Duration = Duration::from_secs(8);
/// 一层最多回多少个子目录：家目录里几千条会把弹窗和 IPC 一起拖住。
const MAX_ENTRIES: usize = 300;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirListing {
    /// 解析后的真实路径（远端 `pwd -P`），不是用户输入的原样字符串
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<DirEntry>,
    pub truncated: bool,
}

const CD_FAILED: &str = "__SINCEARC_CD_FAILED__";
const PWD_MARK: &str = "__SINCEARC_PWD__";

/// 单引号引用：路径里的 `'` 用 `'\''` 断开，其余原样。
///
/// 脚本本身走 stdin（不经过任何参数转义），这里只需要对付 shell 词法。
fn quote(path: &str) -> String {
    let mut out = String::with_capacity(path.len() + 2);
    out.push('\'');
    for c in path.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

/// 用户输入 → shell 里的目标表达式。空 / `~` / `~/x` 走 `$HOME` 展开 ——
/// 这段字符串只在远端被解释，本地 shell 不参与。
pub(crate) fn target_expr(path: Option<&str>) -> String {
    match path.map(str::trim).filter(|p| !p.is_empty()) {
        None | Some("~") => "\"$HOME\"".to_string(),
        Some(rest) if rest.starts_with("~/") => format!("\"$HOME\"/{}", quote(&rest[2..])),
        Some(other) => quote(other),
    }
}

/// 列一层目录的脚本。输出协议：一行 `__SINCEARC_PWD__\t<真实路径>`，后面是 `ls -1ap`。
pub(crate) fn list_script(path: Option<&str>) -> String {
    format!(
        "cd -- {} 2>/dev/null || {{ echo {}; exit 0; }}\n\
         printf '{}\\t%s\\n' \"$(pwd -P 2>/dev/null || pwd)\"\n\
         ls -1ap 2>/dev/null\n",
        target_expr(path),
        CD_FAILED,
        PWD_MARK,
    )
}

/// 父目录。`/` 这类根没有父级。
pub(crate) fn parent_of(path: &str) -> Option<String> {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return None; // "/" 本身
    }
    let (parent, _) = match trimmed.rfind('/') {
        Some(0) => ("/", &trimmed[1..]),
        Some(idx) => (&trimmed[..idx], &trimmed[idx + 1..]),
        None => return None,
    };
    let parent = parent.trim_end_matches('/');
    Some(if parent.is_empty() {
        "/".to_string()
    } else {
        parent.to_string()
    })
}

fn join(base: &str, name: &str) -> String {
    if base.ends_with('/') {
        format!("{base}{name}")
    } else {
        format!("{base}/{name}")
    }
}

/// 解析脚本输出。`Err` 里的字符串直接给用户看，所以写人话。
pub(crate) fn parse_listing(stdout: &str) -> Result<DirListing, String> {
    let text = stdout.replace('\0', "");
    if text.lines().any(|line| line.trim() == CD_FAILED) {
        return Err("目录不存在，或者当前账号没有访问权限".to_string());
    }
    let mut path = None;
    let mut names = Vec::new();
    let mut truncated = false;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix(&format!("{PWD_MARK}\t")) {
            path = Some(rest.trim_end_matches('\r').to_string());
            continue;
        }
        if path.is_none() {
            continue;
        }
        let raw = line.trim_end_matches('\r');
        // `ls -1ap` 给目录加尾斜杠；`./`、`../` 不是可进入的子目录
        let Some(name) = raw.strip_suffix('/') else {
            continue;
        };
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }
        if names.len() >= MAX_ENTRIES {
            truncated = true;
            break;
        }
        names.push(name.to_string());
    }
    let path = path.ok_or_else(|| "没有读到远端路径（脚本输出不完整）".to_string())?;
    names.sort_by_key(|name| name.to_lowercase());
    Ok(DirListing {
        parent: parent_of(&path),
        entries: names
            .into_iter()
            .map(|name| DirEntry {
                path: join(&path, &name),
                name,
            })
            .collect(),
        path,
        truncated,
    })
}

fn wrap(mut cmd: Command) -> Command {
    #[cfg(windows)]
    {
        // tokio 的 Command 在 Windows 上自带 creation_flags，不需要 std 的 CommandExt。
        // CREATE_NO_WINDOW：GUI 进程里起控制台子进程否则会闪一下黑框。
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

/// 把脚本喂给子进程 stdin，再等它跑完。
async fn feed_and_wait(mut child: Child, script: &str) -> Result<String, String> {
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(script.as_bytes())
            .await
            .map_err(|e| format!("写入远端命令失败：{e}"))?;
        // 必须显式关掉：`bash -s` 读到 EOF 才开始执行
        drop(stdin);
    }
    let out = tokio::time::timeout(LIST_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| "远端列目录超时（8 秒）".to_string())?
        .map_err(|e| format!("远端命令失败：{e}"))?;
    let stdout = decode(&out.stdout);
    if stdout.trim().is_empty() {
        let stderr = decode(&out.stderr);
        return Err(if stderr.trim().is_empty() {
            format!("远端没有输出（退出码 {:?}）", out.status.code())
        } else {
            stderr.trim().to_string()
        });
    }
    Ok(stdout)
}

/// wsl.exe 在没设 `WSL_UTF8=1` 的老版本上输出 UTF-16LE；SSH 是 UTF-8。
/// 先按 UTF-8 试，NUL 密集就按 UTF-16LE 解 —— 中文目录名两种都要能显示。
fn decode(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    let nulls = bytes.iter().filter(|b| **b == 0).count();
    if nulls * 4 > bytes.len() {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    String::from_utf8_lossy(bytes).into_owned()
}

/// 列一层目录（WSL / SSH）。
pub async fn list_dir(profile: &AgentProfile, path: Option<&str>) -> Result<DirListing, String> {
    let script = list_script(path);
    let child = match &profile.launch {
        Launch::Local => return Err("本地连接请用系统目录选择器".to_string()),
        Launch::Wsl { distro, .. } => {
            let mut cmd = Command::new(super::launch::system_tool("wsl.exe"));
            cmd.args(["-d", distro, "--", "bash", "-s"])
                .env("WSL_UTF8", "1")
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            wrap(cmd)
                .spawn()
                .map_err(|e| format!("wsl.exe 起不来：{e}"))?
        }
        Launch::Ssh(spec) => {
            let mut env = std::collections::BTreeMap::new();
            let mut cleanup = None;
            let mut args = super::launch::ssh_common_args(spec, &mut env, &mut cleanup)
                .map_err(|e| format!("SSH 参数构建失败：{e}"))?;
            args.push("bash".to_string());
            args.push("-s".to_string());
            let mut cmd = Command::new(super::launch::system_tool("ssh.exe"));
            cmd.args(args)
                .envs(env)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            let spawned = wrap(cmd).spawn();
            // askpass 临时文件在 spawn 之后就没用了（ssh 已经把路径读进环境）
            if let Some(path) = cleanup {
                let _ = std::fs::remove_file(path);
            }
            spawned.map_err(|e| format!("ssh.exe 起不来：{e}"))?
        }
    };

    let stdout = feed_and_wait(child, &script).await?;
    parse_listing(&stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 目标表达式的四种写法() {
        assert_eq!(target_expr(None), "\"$HOME\"");
        assert_eq!(target_expr(Some("  ")), "\"$HOME\"");
        assert_eq!(target_expr(Some("~")), "\"$HOME\"");
        assert_eq!(target_expr(Some("~/proj")), "\"$HOME\"/'proj'");
        assert_eq!(target_expr(Some("/srv/app")), "'/srv/app'");
    }

    #[test]
    fn 单引号路径不会逃出引用() {
        // 名字带单引号时必须断成 '…'\''…'，否则后面的内容会被当成命令
        assert_eq!(quote("a'b"), "'a'\\''b'");
        assert_eq!(quote("普通 目录"), "'普通 目录'");
    }

    #[test]
    fn 父目录的边界() {
        assert_eq!(parent_of("/home/u"), Some("/home".to_string()));
        assert_eq!(parent_of("/home"), Some("/".to_string()));
        assert_eq!(parent_of("/"), None);
        assert_eq!(parent_of("/home/u/"), Some("/home".to_string()));
    }

    #[test]
    fn 解析输出_只取目录并排序() {
        let out = format!(
            "{PWD_MARK}\t/home/u\r\n./\r\n../\r\nzeta/\r\nAlpha/\r\nnotes.txt\r\n.hidden/\r\n"
        );
        let listing = parse_listing(&out).expect("parse");
        assert_eq!(listing.path, "/home/u");
        assert_eq!(listing.parent.as_deref(), Some("/home"));
        assert_eq!(
            listing
                .entries
                .iter()
                .map(|e| e.name.as_str())
                .collect::<Vec<_>>(),
            vec![".hidden", "Alpha", "zeta"]
        );
        assert_eq!(listing.entries[1].path, "/home/u/Alpha");
        assert!(!listing.truncated);
    }

    #[test]
    fn 目录不存在时给人话() {
        let err = parse_listing(&format!("{CD_FAILED}\n")).expect_err("must fail");
        assert!(err.contains("不存在"), "{err}");
    }

    #[test]
    fn 没有_pwd_行就是输出不完整() {
        let err = parse_listing("docs/\n").expect_err("must fail");
        assert!(err.contains("不完整"), "{err}");
    }

    #[test]
    fn 条目超上限截断且标记() {
        let mut out = format!("{PWD_MARK}\t/srv\n");
        for i in 0..(MAX_ENTRIES + 5) {
            out.push_str(&format!("d{i}/\n"));
        }
        let listing = parse_listing(&out).expect("parse");
        assert_eq!(listing.entries.len(), MAX_ENTRIES);
        assert!(listing.truncated);
    }

    #[test]
    fn utf16le_输出也能解() {
        let text = format!("{PWD_MARK}\t/mnt/c\n中文/\n");
        let bytes: Vec<u8> = text.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        let decoded = decode(&bytes);
        assert!(decoded.contains("中文"), "{decoded}");
        assert_eq!(
            parse_listing(&decoded).expect("parse").entries[0].name,
            "中文"
        );
    }
}
