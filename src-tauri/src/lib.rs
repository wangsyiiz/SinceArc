pub mod acp;
pub mod commands;
pub mod db;
pub mod state;

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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            acp::list_profiles_hint,
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
            commands::agent_connect,
            commands::agent_disconnect,
            commands::agent_respond_request,
            commands::session_new,
            commands::session_prompt,
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
