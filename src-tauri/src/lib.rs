pub mod acp;
pub mod coalesce;
pub mod commands;
pub mod db;
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

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "sincearc=info,tauri=info".into()),
        )
        .init();

    tauri::Builder::default()
        .setup(|app| {
            use tauri::Manager as _;
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let db = db::Db::open(&dir.join("sincearc.db"))?;
            tracing::info!(target: "sincearc::ipc", path = %dir.join("sincearc.db").display(), "db ready");
            app.manage(AppState::new(db));

            // 轨迹保留：启动时清一次，之后每天一次。
            // 界面上写着「轨迹保留 90 天（最多 5 万条），超出会自动清理」——
            // 承诺了就得真的执行，否则那句话就是谎话（design-language §11）。
            {
                use tauri::Manager as _;
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let mut ticker = tokio::time::interval(std::time::Duration::from_secs(24 * 3600));
                    loop {
                        ticker.tick().await;
                        let Some(state) = handle.try_state::<AppState>() else {
                            return;
                        };
                        let cutoff = crate::trace::now_ms()
                            - commands::TRACE_RETENTION_DAYS * 24 * 3600 * 1000;
                        match state
                            .db
                            // 自动清理永远不允许「一次清空」：那是单位/时钟错误的典型表征
                            .prune_traces(cutoff, commands::TRACE_MAX_EVENTS_PER_SESSION, false)
                        {
                            Ok(r) if r.events_deleted > 0 || r.turns_deleted > 0 => {
                                tracing::info!(
                                    target: "sincearc::trace",
                                    events = r.events_deleted,
                                    turns = r.turns_deleted,
                                    "轨迹清理完成"
                                );
                            }
                            Ok(_) => {}
                            Err(e) => {
                                tracing::warn!(target: "sincearc::trace", error = %e, "轨迹清理失败")
                            }
                        }
                    }
                });
            }
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
            commands::session_member_add,
            commands::session_member_remove,
            commands::session_load,
            commands::ipc_subscribe,
            commands::session_trace,
            commands::agent_connect,
            commands::agent_disconnect,
            commands::agent_respond_request,
            commands::session_new,
            commands::session_rebind,
            commands::session_prompt,
            commands::session_cancel,
            commands::profiles_load,
            commands::profiles_save,
            commands::sessions_list,
            commands::session_upsert,
            commands::session_delete,
            commands::session_bind_acp,
            commands::session_apply_mode,
            commands::session_choose_mode,
            commands::messages_append,
            commands::client_log,
            commands::messages_load,
            commands::agent_list_connected,
        ])
        .run(tauri::generate_context!())
        .expect("error while running SinceArc");
}
