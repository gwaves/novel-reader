// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod config_manager;
mod db;
mod models;
mod services;

use commands::*;
use services::sidecar_manager::SidecarManager;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;

pub struct AppState {
    pub sidecar: Arc<Mutex<SidecarManager>>,
    pub db_pool: Arc<db::AppDb>,
    pub config: Arc<Mutex<config_manager::ConfigManager>>,
    pub app_dir: PathBuf,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let handle = app.handle().clone();

            let app_dir = dirs::data_dir()
                .expect("Failed to get data dir")
                .join("NovelReader");
            std::fs::create_dir_all(&app_dir)?;
            std::fs::create_dir_all(app_dir.join("novels"))?;
            std::fs::create_dir_all(app_dir.join("models"))?;

            let db_path = app_dir.join("app.db");
            let db_pool = Arc::new(db::AppDb::new(&db_path)?);
            db_pool.init_schema()?;
            db_pool.init_graph_schema()?;

            let config = Arc::new(Mutex::new(
                config_manager::ConfigManager::new(&app_dir)?
            ));

            let sidecar = Arc::new(Mutex::new(SidecarManager::new(
                handle.clone(),
                app_dir.clone(),
            )));

            // Try to start sidecar in background
            let sidecar_clone = sidecar.clone();
            tauri::async_runtime::spawn(async move {
                let mut mgr = sidecar_clone.lock().await;
                if let Err(e) = mgr.start().await {
                    eprintln!("Sidecar auto-start failed: {}", e);
                } else {
                    let _ = handle.emit("sidecar:status-change", serde_json::json!({
                        "status": "running",
                        "message": "Sidecar started"
                    }));
                }
            });

            app.manage(AppState { sidecar, db_pool, config, app_dir });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            import_novel,
            list_novels,
            get_novel,
            delete_novel,
            get_parse_progress,
            get_graph_data,
            search_entities,
            get_entity_detail,
            merge_entities,
            upsert_entity,
            upsert_relation,
            semantic_search,
            chat,
            chat_stream,
            list_sessions,
            get_session_history,
            delete_session,
            get_settings,
            update_settings,
            list_model_configs,
            upsert_model_config,
            delete_model_config,
            test_model_connection,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
