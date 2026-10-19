//! ACP 接入层。
//!
//! 设计约束（见 docs/acp-notes.md）：
//! 1. 所有协议类型只出现在本模块内 —— UI 只消费 `AcpEvent` 自己的枚举。
//! 2. 进程由我们自己起（tokio::process），不用 crate 的 `process` feature：
//!    WSL 场景中间隔着 `wsl.exe` relay，需要 setsid + 自己记 pid 才能干净杀掉。
//! 3. 协议版本显式钉 v1；`unstable_protocol_v2` 不启用。

pub mod launch;

/// 给前端的能力探测占位：E1 会换成真的 initialize 结果。
#[tauri::command]
pub fn list_profiles_hint() -> Vec<&'static str> {
    vec!["wsl:hermes acp", "local:mock"]
}
