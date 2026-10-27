pub mod acp;
pub mod coalesce;
pub mod commands;
pub mod db;
pub mod lock;
pub mod mcp;
pub mod mention;
pub mod message_kind;
pub mod state;
pub mod trace;
pub mod wire;

use state::AppState;

#[tauri::command]
fn app_info() -> serde_json::Value {
    serde_json::json!({
        "name": "SinceArc",
        "version": env!("CARGO_PKG_VERSION"),
        "protocol": "acp/v1",
    })
}

/// 日志同时写 stderr 与 `app_data_dir/logs/sincearc.log`。
///
/// 只写 stdout 在桌面应用里等于没记录：双击启动时没有终端，`tracing::warn!` 谁也看不见
/// （所有者 2026-10-23：脏值不阻塞启动，但**必须留下记录**）。
/// 这里不引 `tracing-appender`：一个追加写的小 writer 足够，少一个依赖。
struct SinkWriter {
    file: std::sync::Arc<std::sync::Mutex<std::fs::File>>,
}

impl std::io::Write for SinkWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if let Ok(mut file) = self.file.lock() {
            let _ = file.write_all(buf);
        }
        let _ = std::io::stderr().write_all(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        if let Ok(mut file) = self.file.lock() {
            let _ = file.flush();
        }
        std::io::stderr().flush()
    }
}

/// 超过阈值就把旧的挪成 `.1`（只留一代），避免日志无限长。
const LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;

fn init_logging(app_dir: &std::path::Path) -> std::io::Result<()> {
    let log_dir = app_dir.join("logs");
    std::fs::create_dir_all(&log_dir)?;
    let path = log_dir.join("sincearc.log");
    if std::fs::metadata(&path).map(|m| m.len() > LOG_MAX_BYTES).unwrap_or(false) {
        let _ = std::fs::rename(&path, log_dir.join("sincearc.log.1"));
    }
    let file = std::fs::OpenOptions::new().create(true).append(true).open(&path)?;
    let sink = std::sync::Arc::new(std::sync::Mutex::new(file));

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "sincearc=info,tauri=info".into()),
        )
        .with_writer(move || SinkWriter { file: sink.clone() })
        .init();

    tracing::info!(
        target: "sincearc::ipc",
        path = %path.display(),
        "日志已挂到文件（同时写 stderr）"
    );
    Ok(())
}

/// 退出兜底：所有还活着的 agent 并发回收，总预算 3 秒。
///
/// 不逐个子进程串行等待：一个远端回收就要 2 秒，串行会把退出拖到十几秒。
/// 超时只记 warn 继续退出 —— 宁可留残留，也不能让用户等一个关不掉的应用。
fn shutdown_agents(app: &tauri::AppHandle) {
    use tauri::Manager as _;

    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let handles = tauri::async_runtime::block_on(state.take_all());
    if handles.is_empty() {
        return;
    }
    let total = handles.len();

    tauri::async_runtime::block_on(async move {
        let mut jobs = tokio::task::JoinSet::new();
        for handle in handles {
            jobs.spawn(async move {
                let id = handle.proc.agent_id().to_string();
                let outcome = handle.proc.kill_tree("exit").await;
                (id, outcome)
            });
        }

        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
        let mut clean = 0usize;
        loop {
            match tokio::time::timeout_at(deadline, jobs.join_next()).await {
                Ok(Some(Ok((id, outcome)))) => {
                    if outcome.clean {
                        clean += 1;
                    }
                    tracing::info!(
                        target: "sincearc::proc",
                        id = %id,
                        clean = outcome.clean,
                        result = %outcome.describe(),
                        "exit cleanup finished"
                    );
                }
                Ok(Some(Err(e))) => {
                    tracing::warn!(target: "sincearc::proc", error = %e, "exit cleanup task failed")
                }
                Ok(None) => break,
                Err(_) => {
                    tracing::warn!(
                        target: "sincearc::proc",
                        agents = total,
                        "exit cleanup budget exceeded (3s); possible residue"
                    );
                    jobs.abort_all();
                    break;
                }
            }
        }
        tracing::info!(
            target: "sincearc::proc",
            agents = total,
            clean,
            "exit cleanup summary"
        );
    });
}

pub fn run() {
    let app = tauri::Builder::default()
        // 自动更新：更新包走 minisign 签名（与 Authenticode 无关），端点见 docs/distribution.md §9
        .plugin(tauri_plugin_updater::Builder::new().build())
        // 更新装完后重启自己
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            use tauri::Manager as _;
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            init_logging(&dir)?;
            let db = db::Db::open(&dir.join("sincearc.db"))?;
            tracing::info!(target: "sincearc::ipc", path = %dir.join("sincearc.db").display(), "db ready");
            app.manage(AppState::new(db));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            acp::list_profiles_hint,
            commands::command_preview,
            commands::agent_probe,
            commands::agent_discover,
            commands::agent_discovery_cached,
            commands::agent_user_test,
            commands::agent_users_list,
            commands::agent_user_save,
            commands::agent_user_delete,
            commands::session_members,
            commands::mention_resolve,
            commands::session_member_add,
            commands::session_member_remove,
            commands::session_load,
            commands::ipc_subscribe,
            commands::session_trace,
            commands::session_trace_backfill,
            commands::session_storage_stats,
            commands::agent_connect,
            commands::agent_disconnect,
            commands::agent_respond_request,
            commands::permission_allow_turn,
            commands::permission_revoke_turn,
            commands::session_new,
            commands::session_rebind,
            commands::session_prompt,
            commands::session_steer,
            commands::session_cancel,
            commands::delegate_task,
            commands::delegate_wait,
            commands::delegate_cancel,
            commands::profiles_load,
            commands::profiles_save,
            commands::mcp_catalog,
            commands::mcp_upsert,
            commands::mcp_delete,
            commands::session_set_mcp_names,
            commands::profile_set_default_mcp,
            commands::session_mcp_state,
            commands::settings_load,
            commands::settings_save,
            commands::open_external,
            commands::sessions_list,
            commands::session_upsert,
            commands::session_delete,
            commands::session_bind_acp,
            commands::session_apply_mode,
            commands::session_choose_mode,
            commands::messages_append,
            commands::client_log,
            commands::messages_load,
            commands::session_usage,
            commands::agent_list_connected,
        ])
        .build(tauri::generate_context!())
        .expect("error while building SinceArc");

    app.run(|app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
            shutdown_agents(app_handle);
        }
        _ => {}
    });
}
