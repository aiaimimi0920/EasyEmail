use serde::{Deserialize, Serialize};

use crate::app_state::AppState;
use crate::avatar::{
    clear_avatar_cache, clear_contact_avatar, fetch_pending_avatars, load_avatar_settings,
    persist_fetched_avatars, plan_sender_avatar_resolution, save_avatar_settings,
    set_contact_avatar, AvatarSettingsDto, SenderAvatarDto,
};
use crate::domain::temp_mailbox::TempMailbox;
use crate::easyemail::http::HttpEasyEmailAdapter;
use crate::easyemail::models::CreateTempMailboxRequest;
use crate::error::{ActionRequired, AppError, ErrorCategory, ErrorDto};
use crate::imap::adapter::ImapAdapter;
use crate::imap::models::ImapConnectionProfile;
use crate::imap::native::NativeImapAdapter;
use crate::secret::windows::WindowsCredentialManagerVault;
use crate::services::agent_service::{
    agent_send_task as send_agent_task_mail, AgentSendTaskRequest, AgentSendTaskResult,
};
use crate::services::easyemail_service::{
    create_temp_mailbox, get_easyemail_settings, refresh_anonymous_temp_mailboxes,
    refresh_temp_mailbox, test_easyemail_connection, update_easyemail_settings,
    CreateTempMailboxServiceRequest, EasyEmailConnectionTestRequest, EasyEmailSettingsDto,
    TempRefreshAnonymousRequest, TempRefreshMailboxRequest, TempRefreshResult,
};
use crate::services::normal_account_service::{
    add_manual_imap_account, apply_normal_message_action, fetch_planned_message_body,
    fetch_planned_move, load_message_detail_with_imap_body, persist_planned_message_body,
    persist_planned_move, persist_planned_remote_flag, plan_archive_action, plan_message_detail,
    plan_move_action, plan_permanent_delete_action, plan_remote_flag_action,
    push_planned_remote_flag, sync_recent_headers, ManualImapAccountRequest, NormalMessageAction,
    NormalMessageActionRequest, NormalMessageActionResult, RemoteFlagKind,
    SyncRecentHeadersRequest, SyncRecentHeadersResult,
};
use crate::services::platform_account_service::{
    dev_platform_account_session, query_dev_platform_account, PlatformAccountQueryDto,
    PlatformAccountQueryRequest, PlatformAccountSessionDto,
};
use crate::services::send_service::{enqueue_send_message, SendMessageRequest, SendMessageResult};
use crate::services::temp_mailbox_service::{
    promote_temp_mailbox, PromoteTempMailboxRequest, PromoteTempMailboxResult,
};
use crate::services::verification_service::{
    list_recent_codes, poll_temp_mailbox_for_code, reclassify_message,
    VerificationListRecentRequest, VerificationPollResult, VerificationPollTempMailboxRequest,
    VerificationReclassifyRequest,
};
use crate::smtp::native::NativeSmtpAdapter;
use crate::storage::account_repository::{
    ensure_anonymous_virtual_account, get_smtp_source_for_account, insert_agent_account,
    list_agent_accounts, list_normal_accounts, AccountRow, NewAgentAccount,
};
use crate::storage::agent_repository::{
    get_agent_thread_detail, insert_agent_service, list_agent_services, list_agent_threads,
    AgentMessageRow, AgentServiceRow, AgentThreadDetail, AgentThreadRow, NewAgentService,
};
use crate::storage::contact_repository::{create_contact, list_contacts, ContactRow, NewContact};
use crate::storage::mail_taxonomy_repository::{
    delete_mail_taxonomy_item, get_mail_taxonomy_item, list_mail_taxonomy_items,
    update_mail_taxonomy_item, upsert_mail_taxonomy_item, MailTaxonomyItemRow, NewMailTaxonomyItem,
};
#[cfg(test)]
use crate::storage::message_repository::MessageLocalState;
use crate::storage::message_repository::{
    clear_message_source_folder_name, clear_message_source_label_name,
};
use crate::storage::message_repository::{
    convert_scheduled_send_to_local_draft, delete_local_draft_message,
    list_anonymous_messages_with_options, list_newsletter_subscriptions,
    list_normal_account_messages_with_options, list_promoted_account_messages_with_options,
    replace_message_source_folder_name, replace_message_source_label_name, set_message_source_flag,
    set_message_source_label, set_newsletter_subscription_hidden, upsert_local_draft_message,
    AnonymousMessageRow, NewLocalDraftMessage, NewsletterSubscriptionRow, NormalAccountMessageRow,
    NormalMessageDetailRow, PromotedAccountMessageRow,
};
use crate::storage::send_queue_repository::{
    cancel_scheduled_send_by_message_id, get_send_queue_item, list_recent_send_queue, SendQueueRow,
};
use crate::storage::temp_mailbox_repository::{list_temp_mailboxes, TempMailboxRow};
use crate::storage::verification_repository::RecentVerificationCodeRow;
use crate::time::now_rfc3339;
use crate::workers::send_queue_worker::{
    run_send_queue_due_batch, run_send_queue_item, run_send_queue_once, SendQueueWorkerRunResult,
};

mod agents;
mod avatars;
mod contacts;
mod message_actions;
mod message_detail;
mod message_queries;
mod normal_accounts;
mod platform;
mod sending;
mod support;
mod taxonomy;
mod temp_mailbox;
mod verification;

pub use agents::*;
pub use avatars::*;
pub use contacts::*;
pub use message_actions::*;
pub use message_detail::*;
pub use message_queries::*;
pub use normal_accounts::*;
pub use platform::*;
pub use sending::*;
pub use taxonomy::*;
pub use temp_mailbox::*;
pub use verification::*;

use normal_accounts::account_row_to_dto;
use support::{lock_error, message_action_error, message_label_invalid, message_list_error};
use temp_mailbox::refresh_result_to_dto;

#[cfg(test)]
use agents::agent_thread_detail_to_dto;
#[cfg(test)]
use message_detail::normal_message_detail_to_dto;
#[cfg(test)]
use message_queries::{
    anonymous_message_row_to_dto, newsletter_subscription_row_to_dto, normal_message_row_to_dto,
};
#[cfg(test)]
use sending::send_queue_row_to_dto;
#[cfg(test)]
use taxonomy::mail_taxonomy_row_to_dto;
#[cfg(test)]
use temp_mailbox::{promote_result_to_dto, temp_mailbox_row_to_dto};
#[cfg(test)]
use verification::{verification_code_row_to_dto, verification_poll_result_to_dto};

#[cfg(test)]
mod tests;
