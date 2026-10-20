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
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            app_info,
            acp::list_profiles_hint,
            commands::agent_connect,
            commands::agent_disconnect,
            commands::session_new,
            commands::agent_list_connected,
        ])
        .run(tauri::generate_context!())
        .expect("error while running SinceArc");
}
