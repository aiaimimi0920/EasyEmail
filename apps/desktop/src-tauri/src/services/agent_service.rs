use rusqlite::Connection;
use uuid::Uuid;

use crate::error::AppError;
use crate::storage::account_repository::{get_account, get_smtp_source_for_account};
use crate::storage::agent_repository::{
    create_agent_thread, find_agent_thread_by_outgoing_rfc_message_id, get_agent_service,
    get_agent_service_by_email, get_agent_thread, insert_agent_message,
    update_agent_thread_after_incoming, update_agent_thread_after_outgoing, AgentThreadRow,
    NewAgentMessage, NewAgentThread,
};
use crate::storage::message_repository::{
    get_message_for_agent_association, insert_outgoing_message, NewOutgoingMessage,
};
use crate::storage::send_queue_repository::{enqueue_send, NewSendQueueItem};

#[path = "agent_service_models.rs"]
mod models;

pub use models::{
    AgentReplyAssociationRequest, AgentReplyAssociationResult, AgentSendTaskRequest,
    AgentSendTaskResult,
};

#[path = "agent_service_validation.rs"]
mod validation;

use validation::{
    agent_reply_message_not_found, agent_sender_not_found, agent_sender_scope_required,
    agent_sender_send_not_enabled, agent_sender_smtp_missing, agent_service_default_sender_missing,
    agent_service_not_found, agent_service_unknown, agent_thread_missing_after_reply,
    agent_thread_missing_after_send, dedupe_non_empty, normalize_agent_reply_association_request,
    normalize_agent_send_task_request, storage_error, validate_agent_service_trust,
};

pub fn agent_send_task(
    connection: &Connection,
    request: AgentSendTaskRequest,
    now: String,
) -> Result<AgentSendTaskResult, AppError> {
    let request = normalize_agent_send_task_request(request)?;
    let sender = get_account(connection, &request.sender_account_id)
        .map_err(storage_error)?
        .ok_or_else(|| agent_sender_not_found(&request.sender_account_id))?;
    if sender.scope != "agent" {
        return Err(agent_sender_scope_required(&sender.id));
    }
    if sender.send_status != "enabled" {
        return Err(agent_sender_send_not_enabled(
            &sender.id,
            &sender.send_status,
        ));
    }

    let service = get_agent_service(connection, &request.agent_service_id)
        .map_err(storage_error)?
        .ok_or_else(|| agent_service_not_found(&request.agent_service_id))?;
    validate_agent_service_trust(&service.trust_level, request.confirm_restricted)?;

    let source = get_smtp_source_for_account(connection, &sender.id)
        .map_err(storage_error)?
        .ok_or_else(|| agent_sender_smtp_missing(&sender.id))?;
    let from_address = source
        .account
        .primary_address
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| source.address.clone());
    let transaction = connection.unchecked_transaction().map_err(storage_error)?;
    let message = insert_outgoing_message(
        &transaction,
        NewOutgoingMessage {
            account_id: sender.id.clone(),
            source_id: source.source_id.clone(),
            from_address,
            target_address: service.email_address.clone(),
            subject: request.subject.clone(),
            body_text: request.body_text,
            now: now.clone(),
        },
    )
    .map_err(storage_error)?;
    let thread = create_agent_thread(
        &transaction,
        NewAgentThread {
            agent_service_id: service.id,
            sender_account_id: sender.id.clone(),
            subject: request.subject,
            correlation_key: format!("agent-{}", Uuid::new_v4()),
            now: now.clone(),
        },
    )
    .map_err(storage_error)?;
    let agent_message = insert_agent_message(
        &transaction,
        NewAgentMessage {
            thread_id: thread.id.clone(),
            message_id: message.id.clone(),
            direction: "outgoing".to_string(),
            semantic_role: "task_request".to_string(),
            parsed_status: Some("queued".to_string()),
            parsed_payload_json: "{}".to_string(),
            now: now.clone(),
        },
    )
    .map_err(storage_error)?;
    update_agent_thread_after_outgoing(
        &transaction,
        &thread.id,
        &message.id,
        "awaiting_reply",
        &now,
    )
    .map_err(storage_error)?;
    let queue = enqueue_send(
        &transaction,
        NewSendQueueItem {
            account_id: sender.id,
            source_id: source.source_id,
            message_id: message.id,
            target_address: service.email_address,
            cc_addresses: Vec::new(),
            bcc_addresses: Vec::new(),
            scheduled_at: None,
            now: now.clone(),
        },
    )
    .map_err(storage_error)?;
    let thread = get_agent_thread(&transaction, &thread.id)
        .map_err(storage_error)?
        .ok_or_else(|| agent_thread_missing_after_send(&thread.id))?;
    transaction.commit().map_err(storage_error)?;

    Ok(AgentSendTaskResult {
        thread,
        queue,
        agent_message,
    })
}

pub fn associate_incoming_agent_reply(
    connection: &Connection,
    request: AgentReplyAssociationRequest,
    now: String,
) -> Result<AgentReplyAssociationResult, AppError> {
    let request = normalize_agent_reply_association_request(request)?;
    let message = get_message_for_agent_association(connection, &request.message_id)
        .map_err(storage_error)?
        .ok_or_else(|| agent_reply_message_not_found(&request.message_id))?;
    let service = get_agent_service_by_email(connection, &request.from_address)
        .map_err(storage_error)?
        .ok_or_else(|| agent_service_unknown(&request.from_address))?;

    if let Some(thread) = find_thread_by_reply_headers(connection, &service.id, &request)? {
        let transaction = connection.unchecked_transaction().map_err(storage_error)?;
        let agent_message = insert_agent_message(
            &transaction,
            NewAgentMessage {
                thread_id: thread.id.clone(),
                message_id: message.message_id,
                direction: "incoming".to_string(),
                semantic_role: "agent_reply".to_string(),
                parsed_status: Some("linked".to_string()),
                parsed_payload_json: "{}".to_string(),
                now: now.clone(),
            },
        )
        .map_err(storage_error)?;
        update_agent_thread_after_incoming(
            &transaction,
            &thread.id,
            &agent_message.message_id,
            "in_progress",
            &now,
        )
        .map_err(storage_error)?;
        let thread = get_agent_thread(&transaction, &thread.id)
            .map_err(storage_error)?
            .ok_or_else(|| agent_thread_missing_after_reply(&thread.id))?;
        transaction.commit().map_err(storage_error)?;

        return Ok(AgentReplyAssociationResult {
            status: "linked".to_string(),
            thread,
            agent_message,
        });
    }

    let sender_account_id = service
        .default_sender_account_id
        .clone()
        .ok_or_else(|| agent_service_default_sender_missing(&service.id))?;
    let transaction = connection.unchecked_transaction().map_err(storage_error)?;
    let thread = create_agent_thread(
        &transaction,
        NewAgentThread {
            agent_service_id: service.id,
            sender_account_id,
            subject: message.subject,
            correlation_key: format!("agent-unmatched-{}", Uuid::new_v4()),
            now: now.clone(),
        },
    )
    .map_err(storage_error)?;
    let agent_message = insert_agent_message(
        &transaction,
        NewAgentMessage {
            thread_id: thread.id.clone(),
            message_id: message.message_id,
            direction: "incoming".to_string(),
            semantic_role: "agent_reply".to_string(),
            parsed_status: Some("needs_attention".to_string()),
            parsed_payload_json: "{}".to_string(),
            now: now.clone(),
        },
    )
    .map_err(storage_error)?;
    update_agent_thread_after_incoming(
        &transaction,
        &thread.id,
        &agent_message.message_id,
        "needs_attention",
        &now,
    )
    .map_err(storage_error)?;
    let thread = get_agent_thread(&transaction, &thread.id)
        .map_err(storage_error)?
        .ok_or_else(|| agent_thread_missing_after_reply(&thread.id))?;
    transaction.commit().map_err(storage_error)?;

    Ok(AgentReplyAssociationResult {
        status: "needs_attention".to_string(),
        thread,
        agent_message,
    })
}

fn find_thread_by_reply_headers(
    connection: &Connection,
    agent_service_id: &str,
    request: &AgentReplyAssociationRequest,
) -> Result<Option<AgentThreadRow>, AppError> {
    let mut candidates = Vec::new();
    if let Some(in_reply_to) = request.in_reply_to_message_id.as_ref() {
        candidates.push(in_reply_to.clone());
    }
    candidates.extend(request.references.iter().cloned());

    for candidate in dedupe_non_empty(candidates) {
        let thread =
            find_agent_thread_by_outgoing_rfc_message_id(connection, agent_service_id, &candidate)
                .map_err(storage_error)?;
        if thread.is_some() {
            return Ok(thread);
        }
    }
    Ok(None)
}

#[cfg(test)]
#[path = "agent_service_tests.rs"]
mod tests;
