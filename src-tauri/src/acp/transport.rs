//! stdio 传输：起进程、按行分帧、请求/响应配对、入站消息分发。
//!
//! 约束（来自 ACP 规范）：
//! - 消息是换行分隔的 JSON，一条消息内不得含裸换行；
//! - stdout 只放协议，stderr 是自由日志，必须单开一路；
//! - 一次 read 可能切在任意位置，所以按 `\n` 切分并保留残余片段。
//!
//! 分流是双向的（这是 S0 改造的要点）：
//! - 出站：`request()` 分配 id、登记 pending 表、写 stdin，然后等自己的 oneshot；
//! - 入站：reader task 把每条消息分成 **响应**（有 id 无 method，路由到 pending）、
//!   **请求**（有 id 有 method，agent → client，例如 `session/request_permission`）、
//!   **通知**（无 id 有 method，例如 `session/update`）。
//!
//! 旧实现让 `request()` 直接读 `lines` 并丢弃不匹配的消息 —— 那样并发两个请求就会串号，
//! 且通知与 client 请求会被无声吞掉。

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot};

use super::launch::AgentProfile;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 入站消息。reader task 分好类之后交给上层消费。
#[derive(Debug, Clone)]
pub enum Incoming {
    /// agent → client 的请求，必须回响应，否则 agent 会一直等
    Request {
        id: u64,
        method: String,
        params: Value,
    },
    /// 单向通知：`session/update` 之类
    Notification { method: String, params: Value },
}

#[derive(Debug)]
pub enum TransportError {
    Spawn {
        program: String,
        source: std::io::Error,
    },
    Io(std::io::Error),
    Timeout(u64),
    Closed,
    Json(serde_json::Error),
    Agent(Value),
    Launch(String),
    /// 握手失败：把 agent 自己吐的 stderr 尾部带上，否则只剩一句 "closed stdout"
    Handshake {
        reason: String,
        stderr_tail: Vec<String>,
    },
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Spawn { program, source } => write!(f, "spawn `{program}` failed: {source}"),
            Self::Io(e) => write!(f, "io failed: {e}"),
            Self::Timeout(s) => write!(f, "timed out after {s}s"),
            Self::Closed => write!(f, "agent closed stdout"),
            Self::Json(e) => write!(f, "bad json: {e}"),
            Self::Agent(v) => write!(f, "agent returned error: {v}"),
            Self::Launch(msg) => write!(f, "cannot start agent: {msg}"),
            Self::Handshake {
                reason,
                stderr_tail,
            } => {
                if stderr_tail.is_empty() {
                    write!(f, "handshake failed: {reason}")
                } else {
                    write!(
                        f,
                        "handshake failed: {reason}\n--- agent stderr ---\n{}",
                        stderr_tail.join("\n")
                    )
                }
            }
        }
    }
}

impl std::error::Error for TransportError {}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, Value>>>>>;

pub struct AgentProcess {
    child: tokio::sync::Mutex<Child>,
    writer: Arc<tokio::sync::Mutex<ChildStdin>>,
    pending: Pending,
    next_id: AtomicU64,
    /// askpass 之类的临时文件；进程对象销毁时删掉，不留密码在磁盘上
    cleanup: Option<std::path::PathBuf>,
}

impl Drop for AgentProcess {
    fn drop(&mut self) {
        if let Some(p) = &self.cleanup {
            let _ = std::fs::remove_file(p);
        }
    }
}

impl AgentProcess {
    /// 结束进程。WSL/SSH 场景的进程组清理在 E1.1 补（现在只杀直接子进程）。
    pub async fn kill(&self) {
        let _ = self.child.lock().await.kill().await;
    }

    pub async fn pid(&self) -> Option<u32> {
        self.child.lock().await.id()
    }
}

impl AgentProcess {
    /// 发一条请求并等 id 匹配的响应。
    ///
    /// 与旧实现的区别：不再独占 `self` —— 内部用 pending 表配对，
    /// 所以可以并发发多条（`&self`）。通知与 agent 请求走 `incoming`。
    pub async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, TransportError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel::<Result<Value, Value>>();
        self.pending
            .lock()
            .expect("pending map poisoned")
            .insert(id, tx);

        let msg = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let mut payload = serde_json::to_string(&msg).map_err(TransportError::Json)?;
        payload.push('\n');

        {
            let mut w = self.writer.lock().await;
            if let Err(e) = w.write_all(payload.as_bytes()).await {
                self.pending
                    .lock()
                    .expect("pending map poisoned")
                    .remove(&id);
                return Err(TransportError::Io(e));
            }
            if let Err(e) = w.flush().await {
                self.pending
                    .lock()
                    .expect("pending map poisoned")
                    .remove(&id);
                return Err(TransportError::Io(e));
            }
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(v))) => Ok(v),
            Ok(Ok(Err(e))) => Err(TransportError::Agent(e)),
            Ok(Err(_)) => Err(TransportError::Closed),
            Err(_) => {
                self.pending
                    .lock()
                    .expect("pending map poisoned")
                    .remove(&id);
                Err(TransportError::Timeout(timeout.as_secs()))
            }
        }
    }

    /// 回一条响应给 agent（用于 client 侧实现的 `fs/*`、`session/request_permission` 等）。
    pub async fn respond(
        &self,
        id: u64,
        result: Result<Value, Value>,
    ) -> Result<(), TransportError> {
        let msg = match result {
            Ok(v) => serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": v }),
            Err(e) => serde_json::json!({ "jsonrpc": "2.0", "id": id, "error": e }),
        };
        let mut payload = serde_json::to_string(&msg).map_err(TransportError::Json)?;
        payload.push('\n');
        let mut w = self.writer.lock().await;
        w.write_all(payload.as_bytes())
            .await
            .map_err(TransportError::Io)?;
        w.flush().await.map_err(TransportError::Io)
    }

    /// 发一条通知（无 id、无响应）。
    pub async fn notify(&self, method: &str, params: Value) -> Result<(), TransportError> {
        let msg = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        let mut payload = serde_json::to_string(&msg).map_err(TransportError::Json)?;
        payload.push('\n');
        let mut w = self.writer.lock().await;
        w.write_all(payload.as_bytes())
            .await
            .map_err(TransportError::Io)?;
        w.flush().await.map_err(TransportError::Io)
    }
}

/// 起 agent 进程；stderr 单独收集，交给调用方做 debug 面板。
pub fn spawn(
    profile: &AgentProfile,
    cwd: &str,
) -> Result<
    (
        AgentProcess,
        mpsc::Receiver<Incoming>,
        mpsc::Receiver<String>,
    ),
    TransportError,
> {
    let spec = profile
        .command_line(cwd)
        .map_err(|e| TransportError::Launch(e.to_string()))?;
    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    for (k, v) in &spec.env {
        cmd.env(k, v);
    }
    // wsl.exe 默认输出 UTF-16LE（每字符夹 \0），显式要求 UTF-8
    cmd.env("WSL_UTF8", "1");

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd.spawn().map_err(|e| TransportError::Spawn {
        program: spec.program.clone(),
        source: e,
    })?;
    let stdin = child.stdin.take().ok_or(TransportError::Closed)?;
    let stdout = child.stdout.take().ok_or(TransportError::Closed)?;
    let stderr = child.stderr.take().ok_or(TransportError::Closed)?;

    let (line_tx, mut line_rx) = mpsc::channel::<String>(256);
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => break,
                Ok(_) => {
                    let trimmed = line.trim_end_matches(['\r', '\n']);
                    if !trimmed.is_empty() && line_tx.send(trimmed.to_string()).await.is_err() {
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

    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let (incoming_tx, incoming_rx) = mpsc::channel::<Incoming>(256);

    // 分发器：把行流拆成 响应 / 请求 / 通知
    let dispatch_pending = pending.clone();
    tokio::spawn(async move {
        while let Some(line) = line_rx.recv().await {
            let value: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                // 非协议行（agent 误写日志到 stdout）跳过，不要污染解析
                Err(_) => continue,
            };

            let id = value.get("id").and_then(Value::as_u64);
            let method = value
                .get("method")
                .and_then(Value::as_str)
                .map(str::to_string);

            match (id, method) {
                // 响应：有 id、无 method
                (Some(id), None) => {
                    let payload = match value.get("error") {
                        Some(e) => Err(e.clone()),
                        None => Ok(value.get("result").cloned().unwrap_or(Value::Null)),
                    };
                    if let Some(tx) = dispatch_pending
                        .lock()
                        .expect("pending map poisoned")
                        .remove(&id)
                    {
                        let _ = tx.send(payload);
                    } else {
                        tracing::warn!(target: "sincearc::acp", id, "response for unknown id");
                    }
                }
                // agent → client 请求：有 id、有 method，必须回响应
                (Some(id), Some(method)) => {
                    let msg = Incoming::Request {
                        id,
                        method,
                        params: value.get("params").cloned().unwrap_or(Value::Null),
                    };
                    if incoming_tx.send(msg).await.is_err() {
                        break;
                    }
                }
                // 通知：无 id、有 method
                (None, Some(method)) => {
                    let msg = Incoming::Notification {
                        method,
                        params: value.get("params").cloned().unwrap_or(Value::Null),
                    };
                    if incoming_tx.send(msg).await.is_err() {
                        break;
                    }
                }
                // 既无 id 又无 method：垃圾，忽略
                (None, None) => {}
            }
        }

        // stdout 关闭：把所有还在等的请求叫醒，避免调用方一直悬着
        let mut map = dispatch_pending.lock().expect("pending map poisoned");
        map.clear();
    });

    Ok((
        AgentProcess {
            child: tokio::sync::Mutex::new(child),
            writer: Arc::new(tokio::sync::Mutex::new(stdin)),
            pending,
            next_id: AtomicU64::new(1),
            cleanup: spec.cleanup,
        },
        incoming_rx,
        erx,
    ))
}
