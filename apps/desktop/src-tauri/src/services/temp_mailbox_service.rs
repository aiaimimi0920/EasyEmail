use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::error::{ActionRequired, AppError, ErrorCategory};
use crate::storage::account_repository::{list_normal_accounts, AccountRow};
use crate::storage::temp_mailbox_repository::{
    get_temp_mailbox, upgrade_temp_mailbox, TempMailboxRow,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PromoteTempMailboxRequest {
    pub temp_mailbox_id: String,
    pub confirm_lifecycle_ack: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromoteTempMailboxResult {
    pub account: AccountRow,
    pub mailbox: TempMailboxRow,
}

pub fn promote_temp_mailbox(
    connection: &mut Connection,
    request: PromoteTempMailboxRequest,
    now: String,
) -> Result<PromoteTempMailboxResult, AppError> {
    if !request.confirm_lifecycle_ack {
        return Err(AppError {
            code: "temp_upgrade_confirmation_required".to_string(),
            category: ErrorCategory::Validation,
            user_message:
                "Confirm that promotion does not extend the temporary mailbox provider lifetime."
                    .to_string(),
            technical_message: None,
            retryable: false,
            action_required: ActionRequired::Confirm,
            correlation_id: uuid::Uuid::new_v4().to_string(),
            metadata: Box::new(serde_json::json!({ "temp_mailbox_id": request.temp_mailbox_id })),
        });
    }

    let account_id = upgrade_temp_mailbox(connection, &request.temp_mailbox_id, now)
        .map_err(|error| promotion_storage_error(error, &request.temp_mailbox_id))?;
    let account = list_normal_accounts(connection)
        .map_err(storage_error)?
        .into_iter()
        .find(|row| row.id == account_id)
        .ok_or_else(|| promoted_account_missing(&account_id))?;
    let mailbox = get_temp_mailbox(connection, &request.temp_mailbox_id)
        .map_err(storage_error)?
        .ok_or_else(|| temp_mailbox_missing(&request.temp_mailbox_id))?;

    Ok(PromoteTempMailboxResult { account, mailbox })
}

fn promotion_storage_error(error: rusqlite::Error, temp_mailbox_id: &str) -> AppError {
    if matches!(error, rusqlite::Error::QueryReturnedNoRows) {
        return AppError {
            code: "temp_upgrade_not_available".to_string(),
            category: ErrorCategory::Validation,
            user_message: "Only anonymous temporary mailboxes can be promoted.".to_string(),
            technical_message: None,
            retryable: false,
            action_required: ActionRequired::None,
            correlation_id: uuid::Uuid::new_v4().to_string(),
            metadata: Box::new(serde_json::json!({ "temp_mailbox_id": temp_mailbox_id })),
        };
    }

    storage_error(error)
}

fn storage_error(error: rusqlite::Error) -> AppError {
    AppError {
        code: "sqlite_temp_mailbox_failed".to_string(),
        category: ErrorCategory::Storage,
        user_message: "Temporary mailbox state could not be updated.".to_string(),
        technical_message: Some(error.to_string()),
        retryable: true,
        action_required: ActionRequired::Retry,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({})),
    }
}

fn promoted_account_missing(account_id: &str) -> AppError {
    AppError {
        code: "promoted_account_missing".to_string(),
        category: ErrorCategory::Internal,
        user_message: "The promoted account could not be loaded after promotion.".to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::None,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "account_id": account_id })),
    }
}

fn temp_mailbox_missing(temp_mailbox_id: &str) -> AppError {
    AppError {
        code: "temp_mailbox_missing_after_upgrade".to_string(),
        category: ErrorCategory::Internal,
        user_message: "The temporary mailbox could not be loaded after promotion.".to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::None,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "temp_mailbox_id": temp_mailbox_id })),
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use crate::domain::temp_mailbox::TempMailbox;
    use crate::storage::db::open_in_memory_database;
    use crate::storage::migrations::run_migrations;
    use crate::storage::temp_mailbox_repository::insert_temp_mailbox;

    use super::*;

    #[test]
    fn temp_upgrade_requires_confirmation_ack() {
        let mut connection = test_connection();
        let mailbox = seed_temp_mailbox(&connection, "confirm@example.test");

        let error = promote_temp_mailbox(
            &mut connection,
            PromoteTempMailboxRequest {
                temp_mailbox_id: mailbox.id,
                confirm_lifecycle_ack: false,
            },
            "2026-06-12T00:20:00Z".to_string(),
        )
        .expect_err("confirmation required");

        assert_eq!(error.code, "temp_upgrade_confirmation_required");
    }

    fn test_connection() -> Connection {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        connection
    }

    fn seed_temp_mailbox(connection: &Connection, address: &str) -> TempMailbox {
        let mailbox = TempMailbox::new_anonymous(
            address.to_string(),
            "fake".to_string(),
            "Fake Provider".to_string(),
            "2026-06-12T00:00:00Z".to_string(),
        );
        insert_temp_mailbox(connection, &mailbox).expect("insert temp mailbox");
        mailbox
    }
}
