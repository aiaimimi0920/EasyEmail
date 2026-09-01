pub mod app_state;
pub mod avatar;
pub mod commands;
pub mod diagnostics;
pub mod domain;
pub mod easyemail;
pub mod error;
pub mod events;
pub mod imap;
pub mod redaction;
pub mod secret;
pub mod services;
pub mod smtp;
pub mod storage;
pub mod time;
pub mod workers;

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

    if let Err(error) = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::health_check,
            commands::platform_account_get_session,
            commands::platform_account_query_data,
            commands::settings_get_easyemail,
            commands::settings_update_easyemail,
            commands::settings_test_easyemail,
            commands::account_list_normal,
            commands::temp_create_mailbox,
            commands::temp_list_mailboxes,
            commands::temp_upgrade_mailbox,
            commands::temp_refresh_mailbox,
            commands::temp_refresh_anonymous,
            commands::normal_account_test_imap,
            commands::normal_account_add_manual_imap,
            commands::normal_account_sync_recent,
            commands::send_message,
            commands::message_save_local_draft,
            commands::message_delete_local_draft,
            commands::send_queue_list,
            commands::send_queue_run_due_batch,
            commands::send_queue_run_item,
            commands::send_queue_run_once,
            commands::contact_list,
            commands::contact_create,
            commands::agent_add_account,
            commands::agent_list_accounts,
            commands::agent_add_service,
            commands::agent_list_services,
            commands::agent_send_task,
            commands::agent_list_threads,
            commands::agent_get_thread_detail,
            commands::message_list,
            commands::newsletter_subscription_list,
            commands::newsletter_subscription_set_hidden,
            commands::mail_taxonomy_list,
            commands::mail_taxonomy_upsert,
            commands::mail_taxonomy_update,
            commands::mail_taxonomy_delete,
            commands::message_get_detail,
            commands::message_reopen_scheduled_send,
            commands::message_delete_local,
            commands::message_delete_forever,
            commands::message_empty_trash,
            commands::message_set_local_flag,
            commands::message_set_local_folder,
            commands::message_set_local_label,
            commands::verification_list_recent,
            commands::verification_reclassify_message,
            commands::verification_poll_temp_mailbox,
            commands::avatar_get_settings,
            commands::avatar_update_settings,
            commands::avatar_resolve_senders,
            commands::avatar_set_contact,
            commands::avatar_clear_contact,
            commands::avatar_clear_cache
        ])
        .run(tauri::generate_context!())
    {
        eprintln!(
            "EasyEmailAM could not start the application: {}",
            crate::redaction::redact_text(&error.to_string())
        );
    }
}
