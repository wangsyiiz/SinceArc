//! stdio 传输：起进程、按行分帧、请求/响应配对。
//!
//! 约束（来自 ACP 规范）：
//! - 消息是换行分隔的 JSON，一条消息内不得含裸换行；
//! - stdout 只放协议，stderr 是自由日志，必须单开一路；
//! - 一次 read 可能切在任意位置，所以按 `\n` 切分并保留残余片段。

use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::mpsc;

use super::launch::AgentProfile;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug)]
pub enum TransportError {
    Spawn(std::io::Error),
    Io(std::io::Error),
    Timeout(u64),
    Closed,
    Json(serde_json::Error),
    Agent(Value),
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Spawn(e) => write!(f, "spawn failed: {e}"),
            Self::Io(e) => write!(f, "io failed: {e}"),
            Self::Timeout(s) => write!(f, "timed out after {s}s"),
            Self::Closed => write!(f, "agent closed stdout"),
            Self::Json(e) => write!(f, "bad json: {e}"),
            Self::Agent(v) => write!(f, "agent returned error: {v}"),
        }
    }
}

impl std::error::Error for TransportError {}

pub struct AgentProcess {
    pub child: Child,
    pub stdin: ChildStdin,
    pub lines: mpsc::Receiver<String>,
}

/// 起 agent 进程；stderr 单独收集，交给调用方做 debug 面板。
pub fn spawn(profile: &AgentProfile, cwd: &str) -> Result<(AgentProcess, mpsc::Receiver<String>), TransportError> {
    let (program, args) = profile.command_line(cwd);
    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    for (k, v) in &profile.env {
        cmd.env(k, v);
    }
    // wsl.exe 默认输出 UTF-16LE（每字符夹 \0），显式要求 UTF-8
    cmd.env("WSL_UTF8", "1");

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd.spawn().map_err(TransportError::Spawn)?;
    let stdin = child.stdin.take().ok_or(TransportError::Closed)?;
    let stdout = child.stdout.take().ok_or(TransportError::Closed)?;
    let stderr = child.stderr.take().ok_or(TransportError::Closed)?;

    let (tx, rx) = mpsc::channel::<String>(256);
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => break,
                Ok(_) => {
                    let trimmed = line.trim_end_matches(['\r', '\n']);
                    if !trimmed.is_empty() && tx.send(trimmed.to_string()).await.is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let (etx, erx) = mpsc::channel::<String>(256);
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => break,
                Ok(_) => {
                    let trimmed = line.trim_end_matches(['\r', '\n']);
                    if etx.send(trimmed.to_string()).await.is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    Ok((
        AgentProcess {
            child,
            stdin,
            lines: rx,
        },
        erx,
    ))
}

/// 发一条请求并等 id 匹配的响应；通知与其它 id 的响应被丢弃（E2 会分发它们）。
pub async fn request(
    proc: &mut AgentProcess,
    id: u64,
    method: &str,
    params: Value,
    timeout: Duration,
) -> Result<Value, TransportError> {
    let msg = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });
    let mut payload = serde_json::to_string(&msg).map_err(TransportError::Json)?;
    payload.push('\n');

    proc.stdin
        .write_all(payload.as_bytes())
        .await
        .map_err(TransportError::Io)?;
    proc.stdin.flush().await.map_err(TransportError::Io)?;

    let wait = async {
        while let Some(line) = proc.lines.recv().await {
            let value: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue, // 非协议行（例如 agent 误写日志）直接跳过
            };
            if value.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(err) = value.get("error") {
                return Err(TransportError::Agent(err.clone()));
            }
            return Ok(value.get("result").cloned().unwrap_or(Value::Null));
        }
        Err(TransportError::Closed)
    };

    timeout_ok(wait, timeout).await
}

async fn timeout_ok<F>(fut: F, timeout: Duration) -> Result<Value, TransportError>
where
    F: std::future::Future<Output = Result<Value, TransportError>>,
{
    match tokio::time::timeout(timeout, fut).await {
        Ok(r) => r,
        Err(_) => Err(TransportError::Timeout(timeout.as_secs())),
    }
}
