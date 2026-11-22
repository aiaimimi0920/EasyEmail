use tauri::Manager;

pub mod app_state;
pub mod commands;
pub mod core_logs;
pub mod core_runtime;
pub mod credential_broker;
pub mod desktop_credentials;
pub mod error;
pub mod host_lifecycle_guard;
pub mod host_os_security;
pub mod redaction;
pub mod secret;
pub mod webview_security;

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
        .plugin(webview_security::navigation_guard_plugin())
        .manage(app_state)
        .setup(move |app| {
            let runtime =
                core_runtime::DesktopCoreRuntimeState::start_background(app, &application_data_dir)
                    .map_err(std::io::Error::other)?;
            app.manage(runtime);
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main"
                && matches!(
                    event,
                    tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
                )
            {
                window
                    .app_handle()
                    .state::<core_runtime::DesktopCoreRuntimeState>()
                    .stop();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::health_check,
            core_runtime::desktop_core_runtime,
            core_logs::desktop_export_diagnostics,
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
