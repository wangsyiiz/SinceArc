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

#[cfg(windows)]
use super::launch::system_tool;
use super::launch::{AgentProfile, KillTarget, SpawnSpec};

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

/// 已写入 stdout、还没等到响应的请求。用于「投递成功就返回、响应后台吃掉」。
pub struct PendingResponse {
    id: u64,
    rx: oneshot::Receiver<Result<Value, Value>>,
}

/// 一次 kill_tree 的结果。`clean = false` 表示可能有残留，界面要提示。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KillOutcome {
    /// 日志里的回收方式：taskkill / unix-process-group / wsl / ssh
    pub method: String,
    pub clean: bool,
    /// 是否用到了 SIGKILL / taskkill /F
    pub escalated: bool,
    /// 人能读的结论（降级时必须说明为什么可能残留）
    pub detail: String,
}

impl KillOutcome {
    fn clean(method: impl Into<String>, escalated: bool, detail: impl Into<String>) -> Self {
        Self {
            method: method.into(),
            clean: true,
            escalated,
            detail: detail.into(),
        }
    }

    fn degraded(method: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            method: method.into(),
            clean: false,
            escalated: true,
            detail: format!("可能残留：{}", detail.into()),
        }
    }

    pub fn may_leave_residue(&self) -> bool {
        !self.clean
    }

    pub fn describe(&self) -> String {
        let verdict = if self.clean { "clean" } else { "degraded" };
        format!("{} · {} · {}", self.method, verdict, self.detail)
    }
}

pub struct AgentProcess {
    child: tokio::sync::Mutex<Child>,
    writer: Arc<tokio::sync::Mutex<ChildStdin>>,
    pending: Pending,
    next_id: AtomicU64,
    /// 本次启动的短 uuid；日志与远端 pid 文件同名
    agent_id: String,
    /// 回收方式。远端在 spawn 时就把 relay 命令算好了。
    kill: KillTarget,
    /// 本机直起时的 pid / 进程组 id（Unix 下 spawn 时 `process_group(0)`）。
    local_pid: Option<u32>,
    /// kill_tree 幂等：退出事件可能连续来两次；保留第一次的真实结论，
    /// 不能让后续调用把「可能残留」覆盖成 clean。
    last_outcome: tokio::sync::Mutex<Option<KillOutcome>>,
    kill_lock: tokio::sync::Mutex<()>,
    /// askpass 之类的临时文件；进程对象销毁时删掉，不留密码在磁盘上
    cleanup: Option<std::path::PathBuf>,
    /// 远端 agent 的 pid 文件（WSL / SSH）；本机直起时没有
    pid_file: Option<String>,
}

impl Drop for AgentProcess {
    fn drop(&mut self) {
        if let Some(p) = &self.cleanup {
            let _ = std::fs::remove_file(p);
        }
    }
}

#[cfg(unix)]
async fn unix_kill(pid: u32, signal: &str, group: bool) -> bool {
    let target = if group {
        format!("-{pid}")
    } else {
        pid.to_string()
    };
    // 用 /bin/sh 的内建 kill：GUI 启动的进程 PATH 可能不完整，
    // 而 pid/signal 都是我们自己生成的数字与固定串，不存在注入。
    tokio::process::Command::new("/bin/sh")
        .arg("-c")
        .arg(format!("kill {signal} {target}"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(unix)]
async fn unix_group_alive(pid: u32) -> bool {
    unix_kill(pid, "-0", true).await
}

#[cfg(unix)]
async fn unix_pid_alive(pid: u32) -> bool {
    unix_kill(pid, "-0", false).await
}

#[cfg(windows)]
async fn taskkill(pid: u32, force: bool) -> std::io::Result<std::process::ExitStatus> {
    let mut cmd = Command::new(system_tool("taskkill.exe"));
    cmd.arg("/T");
    if force {
        cmd.arg("/F");
    }
    cmd.arg("/PID").arg(pid.to_string());
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .await
}

#[cfg(windows)]
async fn windows_pid_alive(pid: u32) -> bool {
    let filter = format!("PID eq {pid}");
    let output = Command::new(system_tool("tasklist.exe"))
        .args(["/FI", filter.as_str(), "/NH", "/FO", "CSV"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .await;
    let Ok(output) = output else {
        return true;
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let needle = pid.to_string();
    text.lines().any(|line| {
        line.split(',')
            .nth(1)
            .map(|field| field.trim().trim_matches('"') == needle)
            .unwrap_or(false)
    })
}

impl AgentProcess {
    /// 远端 pid 文件路径（没有就是本机直起的进程）
    pub fn remote_pid_file(&self) -> Option<&str> {
        self.pid_file.as_deref()
    }

    /// 本次启动的短 uuid；日志里用它对齐 pid 文件与远端进程。
    pub fn agent_id(&self) -> &str {
        &self.agent_id
    }

    /// 回收整棵进程树。
    ///
    /// `why` 只用于日志：cancel / disconnect / exit / replace。
    /// 本机 Windows 走 taskkill /T（先不带 /F），WSL/SSH 在远端按 pid 组杀；
    /// 没有 setsid 时明确返回 `clean = false`，绝不假装干净。
    pub async fn kill_tree(&self, why: &str) -> KillOutcome {
        let _guard = self.kill_lock.lock().await;
        if let Some(outcome) = self.last_outcome.lock().await.clone() {
            tracing::info!(
                target: "sincearc::proc",
                id = %self.agent_id,
                why,
                method = %outcome.method,
                clean = outcome.clean,
                result = %outcome.detail,
                "agent process tree cleanup already finished"
            );
            return outcome;
        }

        let outcome = match &self.kill {
            KillTarget::Local => self.kill_local(why).await,
            KillTarget::Remote { .. } => self.kill_remote(why).await,
        };
        *self.last_outcome.lock().await = Some(outcome.clone());

        tracing::info!(
            target: "sincearc::proc",
            id = %self.agent_id,
            why,
            method = %outcome.method,
            clean = outcome.clean,
            escalated = outcome.escalated,
            result = %outcome.detail,
            "agent process tree cleanup"
        );
        if outcome.may_leave_residue() {
            tracing::warn!(
                target: "sincearc::proc",
                id = %self.agent_id,
                why,
                method = %outcome.method,
                result = %outcome.detail,
                "agent process tree cleanup degraded"
            );
        }
        outcome
    }

    /// 兼容旧调用点；真正的实现只有 `kill_tree`，不存在「只杀直接子进程」的旁路。
    pub async fn kill(&self) {
        let _ = self.kill_tree("disconnect").await;
    }

    pub async fn pid(&self) -> Option<u32> {
        self.child.lock().await.id()
    }

    /// 把直接子进程收尸，避免本机测试/退出时留下僵尸。
    async fn reap(&self) {
        let mut child = self.child.lock().await;
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        let _ = tokio::time::timeout(Duration::from_millis(500), child.wait()).await;
    }

    /// 远端回收结束后兜底关掉本地 relay。正常情况它在 agent 退出后已自行结束；
    /// 降级时远端子孙可能还在，本地 wsl.exe / ssh.exe 没有理由继续留着。
    async fn stop_relay(&self) {
        let mut child = self.child.lock().await;
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        let _ = child.start_kill();
        let _ = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;
    }

    #[cfg(unix)]
    async fn kill_local(&self, why: &str) -> KillOutcome {
        let Some(pid) = self.local_pid else {
            return KillOutcome::clean("unix-process-group", false, "进程已经退出");
        };
        if !unix_group_alive(pid).await && !unix_pid_alive(pid).await {
            self.reap().await;
            return KillOutcome::clean("unix-process-group", false, "进程组已经退出");
        }

        let group_term = unix_kill(pid, "-TERM", true).await;
        let direct_term = if group_term {
            false
        } else {
            unix_kill(pid, "-TERM", false).await
        };
        tracing::info!(
            target: "sincearc::proc",
            id = %self.agent_id,
            why,
            method = "unix-process-group",
            attempt = 1,
            signal = "TERM",
            group = group_term,
            direct_fallback = direct_term,
            "process tree kill attempt"
        );

        tokio::time::sleep(Duration::from_secs(2)).await;

        let mut escalated = false;
        let group_alive = unix_group_alive(pid).await;
        let direct_alive = unix_pid_alive(pid).await;
        if group_alive || direct_alive {
            escalated = true;
            let group_kill = unix_kill(pid, "-KILL", true).await;
            let direct_kill = if group_kill {
                false
            } else {
                unix_kill(pid, "-KILL", false).await
            };
            tracing::info!(
                target: "sincearc::proc",
                id = %self.agent_id,
                why,
                method = "unix-process-group",
                attempt = 2,
                signal = "KILL",
                group = group_kill,
                direct_fallback = direct_kill,
                "process tree kill attempt"
            );
        } else {
            tracing::info!(
                target: "sincearc::proc",
                id = %self.agent_id,
                why,
                method = "unix-process-group",
                attempt = 2,
                signal = "KILL",
                skipped = true,
                "process tree kill attempt"
            );
        }

        self.reap().await;
        let still_group = unix_group_alive(pid).await;
        let still_direct = unix_pid_alive(pid).await;
        if still_group || still_direct {
            KillOutcome::degraded("unix-process-group", "SIGKILL 后进程组仍有成员")
        } else if !group_term {
            KillOutcome::degraded(
                "unix-process-group",
                "进程组 TERM 失败，已降级为只杀直接子进程",
            )
        } else {
            KillOutcome::clean("unix-process-group", escalated, "进程组已全部退出")
        }
    }

    #[cfg(windows)]
    async fn kill_local(&self, why: &str) -> KillOutcome {
        let Some(pid) = self.local_pid.or(self.pid().await) else {
            return KillOutcome::clean("taskkill /T", false, "进程已经退出");
        };
        if !windows_pid_alive(pid).await {
            self.reap().await;
            return KillOutcome::clean("taskkill /T", false, "进程已经退出");
        }

        let graceful = taskkill(pid, false).await;
        tracing::info!(
            target: "sincearc::proc",
            id = %self.agent_id,
            why,
            method = "taskkill /T",
            attempt = 1,
            force = false,
            ok = graceful.as_ref().map(|s| s.success()).unwrap_or(false),
            "process tree kill attempt"
        );

        tokio::time::sleep(Duration::from_secs(2)).await;

        let mut escalated = false;
        if windows_pid_alive(pid).await {
            escalated = true;
            let forced = taskkill(pid, true).await;
            tracing::info!(
                target: "sincearc::proc",
                id = %self.agent_id,
                why,
                method = "taskkill /T /F",
                attempt = 2,
                force = true,
                ok = forced.as_ref().map(|s| s.success()).unwrap_or(false),
                "process tree kill attempt"
            );
        } else {
            tracing::info!(
                target: "sincearc::proc",
                id = %self.agent_id,
                why,
                method = "taskkill /T /F",
                attempt = 2,
                force = true,
                skipped = true,
                "process tree kill attempt"
            );
        }

        self.reap().await;
        if windows_pid_alive(pid).await {
            KillOutcome::degraded("taskkill /T /F", "taskkill 后进程仍然存在")
        } else if escalated {
            KillOutcome::clean("taskkill /T /F", true, "进程树已全部退出")
        } else {
            KillOutcome::clean("taskkill /T", false, "进程树在宽限期内已退出")
        }
    }

    async fn kill_remote(&self, why: &str) -> KillOutcome {
        let KillTarget::Remote {
            kind,
            program,
            args,
            env,
            id,
            ..
        } = &self.kill
        else {
            return KillOutcome::degraded("remote", "回收目标不是远端进程");
        };

        let mut cmd = Command::new(program);
        cmd.args(args)
            .envs(env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let output = tokio::time::timeout(Duration::from_secs(20), cmd.output()).await;
        self.reap().await;
        self.stop_relay().await;

        let output = match output {
            Ok(Ok(output)) => output,
            Ok(Err(e)) => {
                return KillOutcome::degraded(*kind, format!("远端回收命令起不来：{e}"));
            }
            Err(_) => {
                return KillOutcome::degraded(*kind, "远端回收命令 20 秒内没有结束");
            }
        };

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        for line in stdout
            .lines()
            .map(str::trim)
            .filter(|line| line.starts_with("SINCEARC_"))
        {
            tracing::info!(
                target: "sincearc::proc",
                id = %id,
                why,
                remote = %kind,
                step = line,
                "remote process tree kill step"
            );
        }

        let escalated = stdout
            .lines()
            .map(str::trim)
            .any(|line| line.starts_with("SINCEARC_KILL ") && !line.ends_with(" skipped"));
        if stdout.contains("SINCEARC_KILLED") && output.status.success() {
            KillOutcome::clean(
                *kind,
                escalated,
                if escalated {
                    "远端进程组已全部退出"
                } else {
                    "远端进程组在宽限期内已退出"
                },
            )
        } else if stdout.contains("SINCEARC_DEGRADED") {
            KillOutcome::degraded(
                *kind,
                "setsid 不存在或进程组 kill 失败，只杀了直接子进程",
            )
        } else if stdout.contains("SINCEARC_NO_PID") {
            KillOutcome::degraded(*kind, "远端 pid 文件不存在，无法确认残留")
        } else if stdout.contains("SINCEARC_BAD_PID") {
            KillOutcome::degraded(*kind, "远端 pid 文件内容非法，无法确认残留")
        } else if stdout.contains("SINCEARC_STILL_ALIVE") {
            KillOutcome::degraded(*kind, "SIGKILL 后远端进程组仍有成员")
        } else {
            let detail = if stderr.trim().is_empty() {
                format!("远端回收脚本没有返回明确结果（退出码 {}）", output.status)
            } else {
                format!(
                    "远端回收脚本没有返回明确结果（退出码 {}）：{}",
                    output.status,
                    stderr.trim()
                )
            };
            KillOutcome::degraded(*kind, detail)
        }
    }
}

impl AgentProcess {
    /// 发一条请求，写完 stdout 就返回等待句柄；错误在写入阶段原样返回。
    pub async fn request_detached(
        &self,
        method: &str,
        params: Value,
    ) -> Result<PendingResponse, TransportError> {
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
        let mut payload = match serde_json::to_string(&msg) {
            Ok(payload) => payload,
            Err(e) => {
                self.pending
                    .lock()
                    .expect("pending map poisoned")
                    .remove(&id);
                return Err(TransportError::Json(e));
            }
        };
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

        Ok(PendingResponse { id, rx })
    }

    /// 等一条已发出的请求的响应；超时会从 pending 表摘掉，避免泄漏。
    ///
    /// 有界等待只用于握手 / load / steer 回执这类「一次短交互」。
    /// 单轮 `session/prompt` 必须走 `await_response_unbounded`，不能靠传大数冒充无界。
    pub async fn await_response(
        &self,
        pending: PendingResponse,
        timeout: Duration,
    ) -> Result<Value, TransportError> {
        let PendingResponse { id, rx } = pending;

        match tokio::time::timeout(timeout, rx).await {
            Ok(result) => Self::decode_response(result),
            Err(_) => {
                self.pending
                    .lock()
                    .expect("pending map poisoned")
                    .remove(&id);
                Err(TransportError::Timeout(timeout.as_secs()))
            }
        }
    }

    /// 等一条已发出的请求的响应，**不设墙钟上限**。
    ///
    /// 唯二能叫醒它的是：peer 回包（成功或 agent error）、或 pending sender 被 drop
    /// （stdout 读循环结束时的 `map.clear()`）→ `TransportError::Closed`。
    /// 单轮 prompt 与 delegate 子轮只走这条路径。
    pub async fn await_response_unbounded(
        &self,
        pending: PendingResponse,
    ) -> Result<Value, TransportError> {
        let PendingResponse { rx, .. } = pending;
        Self::decode_response(rx.await)
    }

    fn decode_response(
        response: Result<Result<Value, Value>, oneshot::error::RecvError>,
    ) -> Result<Value, TransportError> {
        match response {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(e)) => Err(TransportError::Agent(e)),
            Err(_) => Err(TransportError::Closed),
        }
    }

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
        let pending = self.request_detached(method, params).await?;
        self.await_response(pending, timeout).await
    }

    /// 发一条请求并**无墙钟上限**地等响应。单轮 prompt 只用这条。
    pub async fn request_unbounded(
        &self,
        method: &str,
        params: Value,
    ) -> Result<Value, TransportError> {
        let pending = self.request_detached(method, params).await?;
        self.await_response_unbounded(pending).await
    }

    #[cfg(test)]
    fn pending_count(&self) -> usize {
        self.pending.lock().expect("pending map poisoned").len()
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
    spawn_with_spec(spec)
}

fn spawn_with_spec(
    spec: SpawnSpec,
) -> Result<
    (
        AgentProcess,
        mpsc::Receiver<Incoming>,
        mpsc::Receiver<String>,
    ),
    TransportError,
> {
    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    // Unix 下让 agent 成为自己进程组的首进程：kill -TERM -<pid> 能带走整棵树。
    // Windows 不用这个，回收走 taskkill /T。
    #[cfg(unix)]
    cmd.process_group(0);

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
    let local_pid = child.id();
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
            agent_id: spec.agent_id,
            kill: spec.kill,
            local_pid,
            last_outcome: tokio::sync::Mutex::new(None),
            kill_lock: tokio::sync::Mutex::new(()),
            cleanup: spec.cleanup,
            pid_file: spec.pid_file,
        },
        incoming_rx,
        erx,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "sincearc-{tag}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[cfg(unix)]
    async fn wait_for_file(path: &std::path::Path) {
        for _ in 0..150 {
            if path.exists() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("timed out waiting for {}", path.display());
    }

    async fn wait_for_nonempty_file(path: &std::path::Path) {
        for _ in 0..500 {
            if std::fs::read_to_string(path)
                .map(|body| !body.is_empty())
                .unwrap_or(false)
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("timed out waiting for non-empty {}", path.display());
    }

    async fn wait_for_pending(proc: &AgentProcess) {
        for _ in 0..500 {
            if proc.pending_count() > 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("timed out waiting for a pending request");
    }

    /// 读 pid 文件。**不 panic**：Windows 上 PowerShell 的 Set-Content 还在写时，
    /// 读取会撞共享冲突（os error 32）。这里把它当成"还没有结果"，交给调用方重试。
    fn read_pids(path: &std::path::Path) -> Vec<u32> {
        std::fs::read_to_string(path)
            .map(|s| {
                s.lines()
                    .filter_map(|line| line.trim().parse::<u32>().ok())
                    .collect()
            })
            .unwrap_or_default()
    }

    async fn wait_for_pids(path: &std::path::Path, want: usize) -> Vec<u32> {
        // 30 秒：并行跑整套测试、或机器上同时有别的 agent 进程时，PowerShell 冷启动能拖到十几秒
        // （实测：跑着 wsl.exe + hermes 探针的同一台机器上，10 秒预算会偶发超时）
        for _ in 0..1500 {
            let pids = read_pids(path);
            if pids.len() >= want {
                return pids;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        Vec::new()
    }

    fn fake_agent_profile(
        dir: &std::path::Path,
        mode: &str,
        marker: &std::path::Path,
        extra_env: &[(&str, &str)],
    ) -> AgentProfile {
        let script = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../scripts/fake-acp-agent.mjs");
        assert!(
            script.exists(),
            "missing fake agent script at {}",
            script.display()
        );

        let mut env = std::collections::BTreeMap::new();
        env.insert("FAKE_PROMPT_MODE".to_string(), mode.to_string());
        env.insert(
            "FAKE_PROMPT_MARKER".to_string(),
            marker.to_string_lossy().into_owned(),
        );
        for (key, value) in extra_env {
            env.insert((*key).to_string(), (*value).to_string());
        }

        #[cfg(windows)]
        let default_node = "node.exe";
        #[cfg(not(windows))]
        let default_node = "node";

        AgentProfile {
            id: "test-prompt-timeout".into(),
            name: "fake acp agent".into(),
            launch: super::super::launch::Launch::Local,
            program: std::env::var("SINCEARC_NODE").unwrap_or_else(|_| default_node.into()),
            args: vec![script.to_string_lossy().into_owned()],
            env,
            default_cwd: dir.to_path_buf(),
        }
    }

    async fn start_fake_agent(
        dir: &std::path::Path,
        mode: &str,
        marker: &std::path::Path,
        extra_env: &[(&str, &str)],
    ) -> (
        AgentProcess,
        mpsc::Receiver<Incoming>,
        mpsc::Receiver<String>,
    ) {
        let profile = fake_agent_profile(dir, mode, marker, extra_env);
        let (proc, incoming, stderr) =
            spawn(&profile, dir.to_str().expect("utf-8 temp dir")).expect("spawn fake agent");
        let initialized = proc
            .request(
                "initialize",
                serde_json::json!({
                    "protocolVersion": 1,
                    "clientCapabilities": {},
                }),
                Duration::from_secs(10),
            )
            .await;
        if let Err(error) = initialized {
            proc.kill().await;
            panic!("fake agent initialize failed: {error}");
        }
        (proc, incoming, stderr)
    }

    async fn new_fake_session(proc: &AgentProcess, dir: &std::path::Path) -> String {
        let created = proc
            .request(
                "session/new",
                serde_json::json!({
                    "cwd": dir.to_string_lossy().into_owned(),
                    "mcpServers": [],
                }),
                Duration::from_secs(10),
            )
            .await
            .expect("session/new");
        created["sessionId"]
            .as_str()
            .expect("sessionId")
            .to_string()
    }

    fn fake_prompt(session_id: &str) -> Value {
        serde_json::json!({
            "sessionId": session_id,
            "prompt": [{ "type": "text", "text": "timeout test" }],
        })
    }

    /// A 的安全底线：prompt 已经发出并收下，外部杀掉进程后，无界等待必须在秒级
    /// 变成 `Closed`，而不是一直悬着或等某个墙钟阈值。
    #[tokio::test]
    async fn killing_agent_wakes_unbounded_prompt_with_closed() {
        let dir = test_dir("prompt-closed");
        let marker = dir.join("prompt-started");
        let (proc, incoming, stderr) = start_fake_agent(&dir, "silent", &marker, &[]).await;
        let session_id = new_fake_session(&proc, &dir).await;
        let proc = Arc::new(proc);

        let prompt_proc = Arc::clone(&proc);
        let prompt = tokio::spawn(async move {
            prompt_proc
                .request_unbounded("session/prompt", fake_prompt(&session_id))
                .await
        });

        wait_for_pending(&proc).await;
        proc.kill().await;

        let result = tokio::time::timeout(Duration::from_secs(8), prompt)
            .await
            .expect("the prompt must wake within seconds of the agent exiting")
            .expect("prompt task panicked");
        assert!(
            matches!(result, Err(TransportError::Closed)),
            "killing the agent must wake the main turn with Closed, got {result:?}"
        );

        let _keep_channels_alive = (incoming, stderr);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// 长时间沉默不是失败：stub 收下 prompt 后 1.5s 才回结果，无界等待必须拿到 Ok。
    /// `commands.rs` 的 Ok 分支把它收成 finished；这里证明传输层不会自行判死。
    #[tokio::test]
    async fn unbounded_prompt_survives_long_silence_then_returns_ok() {
        let dir = test_dir("prompt-delay");
        let marker = dir.join("prompt-started");
        let (proc, incoming, stderr) = start_fake_agent(
            &dir,
            "delay",
            &marker,
            &[("FAKE_PROMPT_DELAY_MS", "1500")],
        )
        .await;
        let session_id = new_fake_session(&proc, &dir).await;

        let result = tokio::time::timeout(
            Duration::from_secs(6),
            proc.request_unbounded("session/prompt", fake_prompt(&session_id)),
        )
        .await
        .expect("a 1.5s silent stretch must not be treated as a failure")
        .expect("silent prompt should still complete");
        assert_eq!(result["stopReason"], "end_turn");

        proc.kill().await;
        let _keep_channels_alive = (incoming, stderr);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// steer 回执仍然有界：50ms 内没有回包就是 `Timeout`，且它只影响投递确认。
    #[tokio::test]
    async fn bounded_steer_ack_times_out_without_agent_reply() {
        let dir = test_dir("steer-ack-timeout");
        let marker = dir.join("prompt-started");
        let (proc, incoming, stderr) = start_fake_agent(&dir, "silent", &marker, &[]).await;
        let session_id = new_fake_session(&proc, &dir).await;

        let pending = proc
            .request_detached("session/prompt", fake_prompt(&session_id))
            .await
            .expect("write prompt");
        wait_for_nonempty_file(&marker).await;
        let started = tokio::time::Instant::now();
        let result = proc
            .await_response(pending, Duration::from_millis(50))
            .await;
        assert!(
            matches!(result, Err(TransportError::Timeout(_))),
            "a silent steer ack must time out, got {result:?}"
        );
        assert!(started.elapsed() < Duration::from_secs(2));

        proc.kill().await;
        let _keep_channels_alive = (incoming, stderr);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// 手动长跑：11 分钟、每 30 秒一条 update，证明超过旧 600s 上限仍是 Ok。
    ///   cargo test --lib acp::transport::tests::unbounded_prompt_survives_eleven_minutes -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "manual: keeps one prompt open for 11 minutes"]
    async fn unbounded_prompt_survives_eleven_minutes() {
        let dir = test_dir("prompt-eleven-minutes");
        let marker = dir.join("prompt-started");
        let (proc, incoming, stderr) = start_fake_agent(
            &dir,
            "long",
            &marker,
            &[
                ("FAKE_PROMPT_LONG_MS", "660000"),
                ("FAKE_PROMPT_INTERVAL_MS", "30000"),
            ],
        )
        .await;
        let session_id = new_fake_session(&proc, &dir).await;

        let result = tokio::time::timeout(
            Duration::from_secs(720),
            proc.request_unbounded("session/prompt", fake_prompt(&session_id)),
        )
        .await
        .expect("11-minute prompt should not be killed by any wall-clock limit")
        .expect("11-minute prompt should finish");
        assert_eq!(result["stopReason"], "end_turn");

        proc.kill().await;
        let _keep_channels_alive = (incoming, stderr);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kill_tree_reaps_forked_child_on_unix() {
        use std::os::unix::fs::PermissionsExt;

        let dir = test_dir("kill-tree-unix");
        let child_file = dir.join("child.pid");
        let parent_file = dir.join("parent.pid");
        let script = dir.join("fake-agent.sh");
        std::fs::write(
            &script,
            "#!/bin/sh\n/bin/sleep 300 &\necho $! > \"$1\"\necho $$ > \"$2\"\nwait\n",
        )
        .expect("write fake agent");
        let mut perms = std::fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script, perms).unwrap();

        let profile = AgentProfile {
            id: "test-unix".into(),
            name: "test".into(),
            launch: super::super::launch::Launch::Local,
            program: script.to_string_lossy().into_owned(),
            args: vec![
                child_file.to_string_lossy().into_owned(),
                parent_file.to_string_lossy().into_owned(),
            ],
            env: std::collections::BTreeMap::new(),
            default_cwd: dir.clone(),
        };
        let (proc, _incoming, _stderr) =
            spawn(&profile, dir.to_str().unwrap()).expect("spawn fake agent");

        let child = wait_for_pids(&child_file, 1).await[0];
        let parent = wait_for_pids(&parent_file, 1).await[0];
        assert!(unix_pid_alive(parent).await, "parent should be alive");
        assert!(unix_pid_alive(child).await, "forked child should be alive");

        let outcome = proc.kill_tree("test").await;
        assert!(outcome.clean, "expected clean kill, got {outcome:?}");

        assert!(
            wait_unix_pid_gone(parent, Duration::from_secs(3)).await,
            "parent {parent} survived kill_tree"
        );
        assert!(
            wait_unix_pid_gone(child, Duration::from_secs(3)).await,
            "forked child {child} survived kill_tree"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    async fn wait_unix_pid_gone(pid: u32, budget: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + budget;
        while tokio::time::Instant::now() < deadline {
            if !unix_pid_alive(pid).await {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        !unix_pid_alive(pid).await
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn missing_setsid_degrades_to_direct_kill_and_reports_residue() {
        use crate::acp::launch::{guarded_exec, remote_kill_script};

        let dir = test_dir("kill-tree-degraded");
        let empty_path = dir.join("empty-path");
        std::fs::create_dir_all(&empty_path).unwrap();
        let pid_file = dir.join("agent.pid");
        let marker_file = dir.join("agent.nosetsid");
        let child_file = dir.join("child.pid");
        let inner = format!(
            "trap '' HUP TERM; /bin/sleep 300 & echo $! > \"{}\"; wait",
            child_file.display()
        );
        let launch_script = guarded_exec(
            "/bin/sh",
            &["-c".to_string(), inner],
            &pid_file.to_string_lossy(),
            &marker_file.to_string_lossy(),
        );

        let id = "test-degraded-1".to_string();
        let kill_script = remote_kill_script(
            &id,
            &pid_file.to_string_lossy(),
            &marker_file.to_string_lossy(),
        )
        .expect("build remote kill script");
        let spec = SpawnSpec {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), launch_script],
            env: std::collections::BTreeMap::from([(
                "PATH".to_string(),
                empty_path.to_string_lossy().into_owned(),
            )]),
            cleanup: None,
            pid_file: Some(pid_file.to_string_lossy().into_owned()),
            agent_id: id.clone(),
            kill: KillTarget::Remote {
                kind: "test",
                program: "/bin/sh".into(),
                args: vec!["-c".into(), kill_script],
                env: std::collections::BTreeMap::from([(
                    "PATH".to_string(),
                    "/usr/bin:/bin".to_string(),
                )]),
                id,
                pid_file: pid_file.to_string_lossy().into_owned(),
            },
        };
        let (proc, _incoming, _stderr) = spawn_with_spec(spec).expect("spawn degraded agent");

        wait_for_file(&pid_file).await;
        wait_for_file(&marker_file).await;
        let child = wait_for_pids(&child_file, 1).await[0];
        assert!(unix_pid_alive(child).await, "forked child should be alive");

        let outcome = proc.kill_tree("test").await;
        assert!(
            outcome.may_leave_residue(),
            "missing setsid must not pretend success: {outcome:?}"
        );
        assert!(
            outcome.detail.contains("可能残留"),
            "detail should say residue is possible: {outcome:?}"
        );
        assert!(
            unix_pid_alive(child).await,
            "direct-only fallback should leave the forked child behind"
        );

        let _ = unix_kill(child, "-KILL", false).await;
        let _ = wait_unix_pid_gone(child, Duration::from_secs(2)).await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(windows)]
    async fn windows_pid_gone_soon(pid: u32, budget: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + budget;
        while tokio::time::Instant::now() < deadline {
            if !windows_pid_alive(pid).await {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        !windows_pid_alive(pid).await
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn kill_tree_reaps_forked_child_on_windows() {
        let dir = test_dir("kill-tree-windows");
        let pid_file = dir.join("pids.txt");
        let script = dir.join("fake-agent.cmd");
        let pid_path = pid_file.to_string_lossy().replace('\'', "''");
        let body = format!(
            "@echo off\r\n\
             powershell -NoProfile -ExecutionPolicy Bypass -Command \"\
             $child = Start-Process -FilePath powershell.exe \
             -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 120' \
             -PassThru -WindowStyle Hidden; \
             Set-Content -LiteralPath '{pid_path}' -Value $PID; \
             Add-Content -LiteralPath '{pid_path}' -Value $child.Id; \
             Start-Sleep -Seconds 120\"\r\n"
        );
        std::fs::write(&script, body).expect("write fake agent");

        let profile = AgentProfile {
            id: "test-windows".into(),
            name: "test".into(),
            launch: super::super::launch::Launch::Local,
            program: "cmd.exe".into(),
            args: vec!["/C".into(), script.to_string_lossy().into_owned()],
            env: std::collections::BTreeMap::new(),
            default_cwd: dir.clone(),
        };
        let (proc, _incoming, _stderr) =
            spawn(&profile, dir.to_str().unwrap()).expect("spawn fake agent");

        let pids = wait_for_pids(&pid_file, 2).await;
        if pids.len() < 2 {
            // 起不来的话别把假进程留在机器上：先回收再失败
            let _ = proc.kill_tree("test-setup-failed").await;
            panic!("expected parent and forked child pids, got {pids:?}");
        }
        for pid in &pids {
            assert!(windows_pid_alive(*pid).await, "pid {pid} should be alive");
        }

        let outcome = proc.kill_tree("test").await;
        assert!(outcome.clean, "expected clean kill, got {outcome:?}");
        for pid in pids {
            assert!(
                windows_pid_gone_soon(pid, Duration::from_secs(3)).await,
                "pid {pid} survived kill_tree"
            );
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
