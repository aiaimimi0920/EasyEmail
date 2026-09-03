use std::sync::Mutex;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::secret::SecretVaultAdapter;
use crate::smtp::adapter::SmtpAdapter;
use crate::smtp::models::{SmtpConnectionProfile, SmtpSendMessage, SmtpSendResult};
use crate::storage::account_repository::get_smtp_source_for_account;
use crate::storage::message_repository::get_message_detail;
use crate::storage::send_queue_repository::{
    claim_due_send_by_id, claim_next_due_scheduled_send, claim_next_due_send, get_send_queue_item,
    mark_send_sent, SendQueueRow,
};

#[path = "send_queue_state.rs"]
mod state;

use state::{
    connection_lock_error, ensure_send_queue_transition, handle_send_failure,
    outgoing_message_missing, recover_stale_sends, smtp_secret_missing, smtp_source_missing,
    storage_error,
};

const MAX_SEND_QUEUE_BATCH_LIMIT: usize = 100;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SendQueueWorkerRunResult {
    pub processed_count: usize,
    pub sent_count: usize,
    pub retry_count: usize,
    pub failed_count: usize,
}

impl SendQueueWorkerRunResult {
    fn merge(&mut self, other: Self) {
        self.processed_count += other.processed_count;
        self.sent_count += other.sent_count;
        self.retry_count += other.retry_count;
        self.failed_count += other.failed_count;
    }
}

struct PreparedSend {
    queue: SendQueueRow,
    profile: SmtpConnectionProfile,
    secret_key: String,
    message: SmtpSendMessage,
    now: String,
}

enum PreparedSendStep {
    Idle,
    Completed(SendQueueWorkerRunResult),
    Ready(Box<PreparedSend>),
}

pub fn run_send_queue_once<V, A>(
    connection: &Connection,
    vault: &V,
    adapter: &A,
    now: String,
) -> Result<SendQueueWorkerRunResult, AppError>
where
    V: SecretVaultAdapter,
    A: SmtpAdapter,
{
    let mut total = recover_stale_sends(connection, &now)?;
    let Some(queue) = claim_next_due_send(connection, &now).map_err(storage_error)? else {
        return Ok(total);
    };

    total.merge(process_claimed_send(
        connection, vault, adapter, queue, now,
    )?);
    Ok(total)
}

pub fn run_send_queue_item<V, A>(
    connection: &Connection,
    vault: &V,
    adapter: &A,
    queue_id: &str,
    now: String,
) -> Result<SendQueueWorkerRunResult, AppError>
where
    V: SecretVaultAdapter,
    A: SmtpAdapter,
{
    let mut total = recover_stale_sends(connection, &now)?;
    let Some(queue) = claim_due_send_by_id(connection, queue_id, &now).map_err(storage_error)?
    else {
        return Ok(total);
    };

    total.merge(process_claimed_send(
        connection, vault, adapter, queue, now,
    )?);
    Ok(total)
}

pub fn run_send_queue_due_batch<V, A>(
    connection: &Connection,
    vault: &V,
    adapter: &A,
    now: String,
    limit: usize,
) -> Result<SendQueueWorkerRunResult, AppError>
where
    V: SecretVaultAdapter,
    A: SmtpAdapter,
{
    let mut total = recover_stale_sends(connection, &now)?;
    let limit = limit.clamp(1, MAX_SEND_QUEUE_BATCH_LIMIT);

    for _ in 0..limit {
        let Some(queue) = claim_next_due_scheduled_send(connection, &now).map_err(storage_error)?
        else {
            break;
        };
        let result = process_claimed_send(connection, vault, adapter, queue, now.clone())?;
        if result.processed_count == 0 {
            break;
        }
        total.merge(result);
    }

    Ok(total)
}

pub fn run_send_queue_once_shared<V, A>(
    connection: &Mutex<Connection>,
    vault: &V,
    adapter: &A,
    now: String,
) -> Result<SendQueueWorkerRunResult, AppError>
where
    V: SecretVaultAdapter,
    A: SmtpAdapter,
{
    let (mut total, step) = {
        let connection = connection.lock().map_err(connection_lock_error)?;
        let total = recover_stale_sends(&connection, &now)?;
        let queue = claim_next_due_send(&connection, &now).map_err(storage_error)?;
        let step = prepare_send_step(&connection, queue, now)?;
        (total, step)
    };

    total.merge(finish_shared_step(connection, vault, adapter, step)?);
    Ok(total)
}

pub fn run_send_queue_item_shared<V, A>(
    connection: &Mutex<Connection>,
    vault: &V,
    adapter: &A,
    queue_id: &str,
    now: String,
) -> Result<SendQueueWorkerRunResult, AppError>
where
    V: SecretVaultAdapter,
    A: SmtpAdapter,
{
    let (mut total, step) = {
        let connection = connection.lock().map_err(connection_lock_error)?;
        let total = recover_stale_sends(&connection, &now)?;
        let queue = claim_due_send_by_id(&connection, queue_id, &now).map_err(storage_error)?;
        let step = prepare_send_step(&connection, queue, now)?;
        (total, step)
    };

    total.merge(finish_shared_step(connection, vault, adapter, step)?);
    Ok(total)
}

pub fn run_send_queue_due_batch_shared<V, A>(
    connection: &Mutex<Connection>,
    vault: &V,
    adapter: &A,
    now: String,
    limit: usize,
) -> Result<SendQueueWorkerRunResult, AppError>
where
    V: SecretVaultAdapter,
    A: SmtpAdapter,
{
    let mut total = {
        let connection = connection.lock().map_err(connection_lock_error)?;
        recover_stale_sends(&connection, &now)?
    };
    let limit = limit.clamp(1, MAX_SEND_QUEUE_BATCH_LIMIT);

    for _ in 0..limit {
        let step = {
            let connection = connection.lock().map_err(connection_lock_error)?;
            let queue = claim_next_due_scheduled_send(&connection, &now).map_err(storage_error)?;
            prepare_send_step(&connection, queue, now.clone())?
        };
        let idle = matches!(&step, PreparedSendStep::Idle);
        let result = finish_shared_step(connection, vault, adapter, step)?;
        if idle {
            break;
        }
        total.merge(result);
    }

    Ok(total)
}

fn process_claimed_send<V, A>(
    connection: &Connection,
    vault: &V,
    adapter: &A,
    queue: SendQueueRow,
    now: String,
) -> Result<SendQueueWorkerRunResult, AppError>
where
    V: SecretVaultAdapter,
    A: SmtpAdapter,
{
    let prepared = match prepare_claimed_send(connection, queue, now) {
        Ok(prepared) => prepared,
        Err(error) => {
            let (queue, now, error) = *error;
            return handle_send_failure(connection, &queue, &now, error);
        }
    };

    let outcome = deliver_prepared_send(vault, adapter, &prepared);
    persist_delivery_outcome(connection, &prepared, outcome)
}

fn prepare_send_step(
    connection: &Connection,
    queue: Option<SendQueueRow>,
    now: String,
) -> Result<PreparedSendStep, AppError> {
    let Some(queue) = queue else {
        return Ok(PreparedSendStep::Idle);
    };

    match prepare_claimed_send(connection, queue, now) {
        Ok(prepared) => Ok(PreparedSendStep::Ready(Box::new(prepared))),
        Err(error) => {
            let (queue, now, error) = *error;
            handle_send_failure(connection, &queue, &now, error).map(PreparedSendStep::Completed)
        }
    }
}

fn prepare_claimed_send(
    connection: &Connection,
    queue: SendQueueRow,
    now: String,
) -> Result<PreparedSend, Box<(SendQueueRow, String, AppError)>> {
    let prepared = (|| -> Result<(SmtpConnectionProfile, String, SmtpSendMessage), AppError> {
        let source = get_smtp_source_for_account(connection, &queue.account_id)
            .map_err(storage_error)?
            .ok_or_else(|| smtp_source_missing(&queue.account_id))?;
        let detail = get_message_detail(connection, &queue.message_id)
            .map_err(storage_error)?
            .ok_or_else(|| outgoing_message_missing(&queue.message_id))?;

        Ok((
            SmtpConnectionProfile {
                host: source.config.host,
                port: source.config.port,
                security: source.config.security,
                username: source.config.username,
            },
            source.secret_key,
            SmtpSendMessage {
                from_address: source.address,
                to_addresses: split_recipient_list(&queue.target_address),
                cc_addresses: queue.cc_addresses.clone(),
                bcc_addresses: queue.bcc_addresses.clone(),
                subject: detail.subject,
                body_text: detail.body_text.unwrap_or(detail.snippet),
            },
        ))
    })();

    match prepared {
        Ok((profile, secret_key, message)) => Ok(PreparedSend {
            queue,
            profile,
            secret_key,
            message,
            now,
        }),
        Err(error) => Err(Box::new((queue, now, error))),
    }
}

fn finish_shared_step<V, A>(
    connection: &Mutex<Connection>,
    vault: &V,
    adapter: &A,
    step: PreparedSendStep,
) -> Result<SendQueueWorkerRunResult, AppError>
where
    V: SecretVaultAdapter,
    A: SmtpAdapter,
{
    match step {
        PreparedSendStep::Idle => Ok(SendQueueWorkerRunResult::default()),
        PreparedSendStep::Completed(result) => Ok(result),
        PreparedSendStep::Ready(prepared) => {
            let outcome = deliver_prepared_send(vault, adapter, &prepared);
            let connection = connection.lock().map_err(connection_lock_error)?;
            persist_delivery_outcome(&connection, &prepared, outcome)
        }
    }
}

fn deliver_prepared_send<V, A>(
    vault: &V,
    adapter: &A,
    prepared: &PreparedSend,
) -> Result<SmtpSendResult, AppError>
where
    V: SecretVaultAdapter,
    A: SmtpAdapter,
{
    let secret = vault
        .load_secret(&prepared.secret_key)?
        .ok_or_else(|| smtp_secret_missing(&prepared.queue.account_id))?;
    adapter.send_message(&prepared.profile, &secret, &prepared.message)
}

fn persist_delivery_outcome(
    connection: &Connection,
    prepared: &PreparedSend,
    outcome: Result<SmtpSendResult, AppError>,
) -> Result<SendQueueWorkerRunResult, AppError> {
    match outcome {
        Ok(_) => {
            let changed = mark_send_sent(connection, &prepared.queue.id, &prepared.now)
                .map_err(storage_error)?;
            if !changed {
                let already_sent = get_send_queue_item(connection, &prepared.queue.id)
                    .map_err(storage_error)?
                    .is_some_and(|row| row.status == "sent");
                ensure_send_queue_transition(already_sent, &prepared.queue.id)?;
            }
            Ok(SendQueueWorkerRunResult {
                processed_count: 1,
                sent_count: 1,
                retry_count: 0,
                failed_count: 0,
            })
        }
        Err(error) => handle_send_failure(connection, &prepared.queue, &prepared.now, error),
    }
}

fn split_recipient_list(value: &str) -> Vec<String> {
    value
        .split(|character: char| character == ',' || character == ';' || character.is_whitespace())
        .map(str::trim)
        .filter(|address| !address.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
#[path = "send_queue_worker_test_support.rs"]
mod test_support;

#[cfg(test)]
#[path = "send_queue_worker_tests.rs"]
mod tests;
