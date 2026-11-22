use tauri::Manager;

pub mod app_state;
pub mod commands;
pub mod core_runtime;
pub mod credential_broker;
pub mod desktop_credentials;
pub mod error;
pub mod redaction;
pub mod secret;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = match app_state::AppState::open_default() {
        Ok(state) => state,
        Err(error) => {
            eprintln!(
                "EasyEmailAM could not initialize local state: {}",
                crate::redaction::redact_text(&error.to_string())
            );
            return;
        }
    };
    let application_data_dir = app_state.data_dir.clone();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(app_state)
        .setup(move |app| {
            let runtime =
                core_runtime::DesktopCoreRuntimeState::start_background(app, &application_data_dir)
                    .map_err(std::io::Error::other)?;
            app.manage(runtime);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::health_check,
            core_runtime::desktop_core_runtime,
            desktop_credentials::desktop_credential_store,
            desktop_credentials::desktop_credential_delete
        ])
        .build(tauri::generate_context!());

    let app = match app {
        Ok(app) => app,
        Err(error) => {
            eprintln!(
                "EasyEmailAM could not build the application: {}",
                crate::redaction::redact_text(&error.to_string())
            );
            return;
        }
    };

    app.run(|app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            app_handle
                .state::<core_runtime::DesktopCoreRuntimeState>()
                .stop();
        }
    });
}
