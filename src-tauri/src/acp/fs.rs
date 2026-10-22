//! ACP 客户端侧只读文件能力。
//!
//! agent 传来的路径不可信：所有请求都必须先归一到绝对路径、解析 `..` 与软链，
//! 再按组件确认仍在该会话的 cwd 子树内。这里不做「猜意图式」纠正，越界直接拒绝。

use std::io::Read;
use std::path::{Component, Path, PathBuf};

/// 单次读取上限。超出后宁可报错，也不要把内存和 IPC 一起拖死。
const MAX_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FsError {
    /// 越界（含 `..`、绝对路径在外面、软链指向外面）。
    Escapes,
    NotFound,
    NotAFile,
    TooLarge(u64),
    Io(String),
}

/// 把 agent 给的路径解析成「确定落在 cwd 子树内」的绝对路径。
///
/// 先做词法归一挡住 `..`，再 canonicalize 解析软链；两步都必须过，
/// 只靠字符串 `starts_with` 会把 `/w/app-other` 误认成 `/w/app` 的子路径。
pub fn resolve_within_cwd(cwd: &Path, requested: &str) -> Result<PathBuf, FsError> {
    // 没有可信的沙箱根就一律拒绝：cwd 为空时 `Path::new("")` 做前缀判断恒真，
    // 等于把整块磁盘开放给 agent（配置里 cwd 允许留空，这条路真的走得到）。
    // 相对 cwd 同样没有确定语义 —— 它会被解析成进程当前目录，不是用户以为的会话目录。
    if cwd.as_os_str().is_empty() || !cwd.is_absolute() {
        return Err(FsError::Escapes);
    }
    let cwd_lexical = lexical_normalize(cwd);
    let requested_path = Path::new(requested);
    let candidate = if requested_path.is_absolute() || requested_path.has_root() {
        requested_path.to_path_buf()
    } else {
        cwd_lexical.join(requested_path)
    };

    // 存在路径直接 canonicalize：让内核先按真实顺序解析 `..` 与软链，
    // 否则 `link/..` 这类路径会被词法归一成与 OS 不同的结果。
    match candidate.canonicalize() {
        Ok(path) => {
            // cwd 正常情况下一定存在；异常环境下退回词法路径，仍按组件比较。
            let canonical_cwd = cwd.canonicalize().unwrap_or(cwd_lexical);
            if path.starts_with(&canonical_cwd) {
                Ok(path)
            } else {
                Err(FsError::Escapes)
            }
        }
        Err(e) => {
            // 路径不存在时谈不上软链逃逸，但仍要挡住 `../secret` 与同前缀兄弟目录。
            let candidate_lexical = lexical_normalize(&candidate);
            if !candidate_lexical.starts_with(&cwd_lexical) {
                Err(FsError::Escapes)
            } else if e.kind() == std::io::ErrorKind::NotFound {
                Err(FsError::NotFound)
            } else {
                Err(FsError::Io(e.to_string()))
            }
        }
    }
}

/// 读取一个 cwd 子树内的 UTF-8 文本文件，可按 1-based 行号切片。
///
/// 非 UTF-8 内容用 lossy 解码：agent 要的是文本，整份拒绝比替换坏字节更糟。
pub fn read_text_file(
    cwd: &Path,
    requested: &str,
    line: Option<i64>,
    limit: Option<i64>,
) -> Result<String, FsError> {
    let path = resolve_within_cwd(cwd, requested)?;
    let metadata = std::fs::metadata(&path).map_err(map_io)?;
    if !metadata.is_file() {
        return Err(FsError::NotAFile);
    }
    if metadata.len() > MAX_BYTES {
        return Err(FsError::TooLarge(metadata.len()));
    }

    // 读的时候再限一次：文件可能在 metadata 与读取之间变大。
    let file = std::fs::File::open(&path).map_err(map_io)?;
    let mut bytes = Vec::with_capacity(metadata.len().min(MAX_BYTES) as usize);
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| FsError::Io(e.to_string()))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(FsError::TooLarge(bytes.len() as u64));
    }

    let text = String::from_utf8_lossy(&bytes);
    Ok(slice_lines(&text, line, limit))
}

/// 处理一条 `fs/read_text_file` 请求。
/// 入参是 ACP 的 params（已反序列化的 Value）与本次请求所属会话的 cwd。
/// 返回 Ok(result) 或 Err(jsonrpc error 对象)，与线上行为完全一致。
pub fn handle_read_request(
    params: &serde_json::Value,
    cwd: &Path,
) -> Result<serde_json::Value, serde_json::Value> {
    let session_id = params
        .get("sessionId")
        .and_then(serde_json::Value::as_str);
    let requested = params.get("path").and_then(serde_json::Value::as_str);
    let (Some(_session_id), Some(requested)) = (session_id, requested) else {
        return Err(jsonrpc_error(-32602, "缺少参数"));
    };

    let line = params.get("line").and_then(serde_json::Value::as_i64);
    let limit = params.get("limit").and_then(serde_json::Value::as_i64);
    read_text_file(cwd, requested, line, limit)
        .map(|content| serde_json::json!({ "content": content }))
        .map_err(|e| read_error_payload(&e, requested))
}

fn read_error_payload(err: &FsError, requested: &str) -> serde_json::Value {
    // 只回显 agent 自己给的相对路径；绝对路径可能被转进第三方日志。
    let path = Path::new(requested);
    let suffix = if path.is_absolute() || path.has_root() {
        String::new()
    } else {
        format!(": {requested}")
    };
    let (code, message) = match err {
        FsError::Escapes => (-32602, format!("路径越界{suffix}")),
        FsError::NotFound => (-32602, format!("文件不存在{suffix}")),
        FsError::NotAFile => (-32602, format!("不是文件{suffix}")),
        FsError::TooLarge(_) => (-32602, format!("文件超过 1 MiB{suffix}")),
        FsError::Io(e) => (-32603, format!("读取文件失败: {e}")),
    };
    jsonrpc_error(code, message)
}

fn jsonrpc_error(code: i64, message: impl Into<String>) -> serde_json::Value {
    serde_json::json!({ "code": code, "message": message.into() })
}

fn slice_lines(text: &str, line: Option<i64>, limit: Option<i64>) -> String {
    let start = line.unwrap_or(1).max(1);
    let start = usize::try_from(start)
        .unwrap_or(usize::MAX)
        .saturating_sub(1);
    let take = match limit {
        None => usize::MAX,
        Some(n) => usize::try_from(n.max(0)).unwrap_or(usize::MAX),
    };
    text.split_inclusive('\n').skip(start).take(take).collect()
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            Component::RootDir => out.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(part) => out.push(part),
        }
    }
    out
}

fn map_io(e: std::io::Error) -> FsError {
    if e.kind() == std::io::ErrorKind::NotFound {
        FsError::NotFound
    } else {
        FsError::Io(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo_cwd() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    }

    #[test]
    fn relative_path_inside_cwd_resolves() {
        let path = resolve_within_cwd(&repo_cwd(), "src/main.rs").expect("inside cwd");
        assert!(path.ends_with(Path::new("src/main.rs")));
    }

    #[test]
    fn parent_traversal_is_rejected() {
        assert_eq!(
            resolve_within_cwd(&repo_cwd(), "../Cargo.toml"),
            Err(FsError::Escapes)
        );
    }

    #[test]
    fn absolute_outside_is_rejected() {
        assert_eq!(
            resolve_within_cwd(&repo_cwd(), "/etc/passwd"),
            Err(FsError::Escapes)
        );
    }

    #[test]
    fn sibling_with_same_prefix_is_rejected() {
        assert_eq!(
            resolve_within_cwd(Path::new("/a/app"), "/a/app-other/x"),
            Err(FsError::Escapes)
        );
    }

    #[test]
    fn empty_cwd_rejects_everything() {
        // 真漏洞回归：`Path::new("").starts_with` 对任何路径都为真，
        // 旧实现下 cwd 留空等于「整盘可读」。
        assert_eq!(
            resolve_within_cwd(Path::new(""), "/etc/passwd"),
            Err(FsError::Escapes)
        );
        assert_eq!(
            resolve_within_cwd(Path::new(""), "Cargo.toml"),
            Err(FsError::Escapes)
        );
    }

    #[test]
    fn relative_cwd_is_rejected() {
        // 相对 cwd 会按进程当前目录解析，和用户以为的「会话目录」不是一回事
        assert_eq!(
            resolve_within_cwd(Path::new("src"), "main.rs"),
            Err(FsError::Escapes)
        );
    }

    #[test]
    fn line_and_limit_slice() {
        let text = read_text_file(&repo_cwd(), "Cargo.toml", Some(1), Some(2))
            .expect("read Cargo.toml");
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], "[package]");
    }

    #[test]
    fn handle_rejects_missing_params() {
        let err = handle_read_request(&serde_json::json!({}), &repo_cwd())
            .expect_err("missing params must fail");
        assert_eq!(err.get("code").and_then(serde_json::Value::as_i64), Some(-32602));
        assert!(err["message"].as_str().unwrap_or("").contains("缺少参数"));
    }

    #[test]
    fn handle_reads_inside_cwd() {
        let params = serde_json::json!({
            "sessionId": "s1",
            "path": "Cargo.toml",
            "line": 1,
            "limit": 1,
        });
        let result = handle_read_request(&params, &repo_cwd()).expect("inside cwd");
        let content = result["content"].as_str().unwrap_or("");
        assert!(content.starts_with("[package]"));
    }

    #[test]
    fn handle_rejects_traversal() {
        let params = serde_json::json!({
            "sessionId": "s1",
            "path": "../Cargo.toml",
        });
        let err = handle_read_request(&params, &repo_cwd()).expect_err("traversal must fail");
        assert_eq!(err.get("code").and_then(serde_json::Value::as_i64), Some(-32602));
        assert!(err["message"].as_str().unwrap_or("").contains("越界"));
    }

    #[test]
    fn handle_rejects_absolute_outside() {
        let params = serde_json::json!({
            "sessionId": "s1",
            "path": "/etc/passwd",
        });
        let err = handle_read_request(&params, &repo_cwd()).expect_err("absolute outside must fail");
        assert_eq!(err.get("code").and_then(serde_json::Value::as_i64), Some(-32602));
    }
}
