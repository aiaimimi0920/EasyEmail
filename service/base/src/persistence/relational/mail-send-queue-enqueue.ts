import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { EasyEmailError } from "../../domain/errors.js";
import type {
  MailScheduledSendReopenResult,
  MailSendEnqueueResult,
  MailSendQueueRepositoryEnqueueInput,
} from "../../domain/mail-send-queue.js";
import { MESSAGE_SELECT_COLUMNS } from "./mail-message-query-sql.js";
import { mapMailMessageDetailRow, type RawMailMessageRow } from "./mail-message-row-mapper.js";
import {
  SEND_QUEUE_SELECT_COLUMNS,
  mapMailSendQueueRow,
  type RawMailSendQueueRow,
} from "./mail-send-queue-row-mapper.js";

const PENDING_SCHEDULED_LABEL = "未发送";

function readQueueRowById(database: DatabaseSync, id: string): RawMailSendQueueRow | undefined {
  return database.prepare(`
    SELECT ${SEND_QUEUE_SELECT_COLUMNS}
    FROM mail_send_queue q
    LEFT JOIN mail_messages m ON m.id = q.message_id
    WHERE q.id = ?
  `).get(id) as unknown as RawMailSendQueueRow | undefined;
}

export function enqueueOutgoingSendInDatabase(
  database: DatabaseSync,
  input: MailSendQueueRepositoryEnqueueInput,
): MailSendEnqueueResult {
  database.exec("BEGIN IMMEDIATE");
  try {
    if (input.idempotencyKey) {
      const existing = database.prepare(`
        SELECT ${SEND_QUEUE_SELECT_COLUMNS}
        FROM mail_send_queue q
        LEFT JOIN mail_messages m ON m.id = q.message_id
        WHERE q.account_id = ? AND q.idempotency_key = ?
        LIMIT 1
      `).get(input.accountId, input.idempotencyKey) as unknown as RawMailSendQueueRow | undefined;
      if (existing) {
        if (existing.payload_fingerprint !== input.payloadFingerprint) {
          throw new EasyEmailError(
            "SEND_IDEMPOTENCY_CONFLICT",
            "Idempotency-Key was already used with a different outgoing message payload.",
          );
        }
        database.exec("COMMIT");
        const queueItem = mapMailSendQueueRow(existing);
        return {
          messageId: queueItem.messageId,
          queueItem,
          deduplicated: true,
        };
      }
    }

    const messageId = `msg_v1_${randomUUID()}`;
    const queueId = `send_v1_${randomUUID()}`;
    const sourceId = `smtp:${input.accountId}`;
    const senderDomain =
      input.senderAddress.slice(input.senderAddress.lastIndexOf("@") + 1).trim().toLowerCase()
      || "easyemail.local";
    const rfcMessageId = input.rfcMessageId?.trim() || `<${randomUUID()}@${senderDomain}>`;
    const observedAt = input.scheduledAt ?? input.now;
    const labelsJson = input.scheduledAt ? JSON.stringify([PENDING_SCHEDULED_LABEL]) : "[]";
    const ccJson = JSON.stringify(input.ccAddresses);
    const bccJson = JSON.stringify(input.bccAddresses);

    database.prepare(`
      INSERT INTO mail_messages (
        id, rfc_message_id, thread_key, subject, from_address, from_name,
        snippet, body_text, body_html, body_cache_state, has_attachments,
        classification, observed_at, version, created_at, updated_at, deleted_at
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'cached', 0, 'outgoing', ?, 1, ?, ?, NULL)
    `).run(
      messageId,
      rfcMessageId,
      input.subject,
      input.senderAddress,
      input.senderName ?? null,
      input.snippet,
      input.bodyText,
      input.bodyHtml ?? null,
      observedAt,
      input.now,
      input.now,
    );

    database.prepare(`
      INSERT INTO mail_message_sources (
        id, message_id, source_kind, source_ref_id, account_id, session_id,
        provider_instance_id, external_message_id, received_address, provider_label,
        lifecycle_state, is_read, is_starred, is_archived, is_important,
        local_folder, labels_json, draft_cc_json, draft_bcc_json, first_seen_at, last_seen_at
      ) VALUES (?, ?, 'smtp', ?, ?, NULL, NULL, NULL, ?, ?, 'ready', 1, 0, 0, 0, 'sent', ?, ?, ?, ?, ?)
    `).run(
      `msrc_v1_${randomUUID()}`,
      messageId,
      sourceId,
      input.accountId,
      input.targetAddress,
      input.providerLabel,
      labelsJson,
      ccJson,
      bccJson,
      input.now,
      input.now,
    );

    database.prepare(`
      INSERT INTO mail_send_queue (
        id, account_id, account_scope, source_id, message_id, sender_address,
        smtp_host, smtp_port, smtp_security, smtp_username, credential_ref_id,
        target_address, cc_addresses_json, bcc_addresses_json, idempotency_key,
        payload_fingerprint, status, attempt_count, scheduled_at, next_retry_at,
        lease_owner, lease_expires_at, provider_message_id, last_error_code,
        last_error_message, version, created_at, updated_at, sent_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, NULL, NULL, NULL, NULL, NULL, 1, ?, ?, NULL)
    `).run(
      queueId,
      input.accountId,
      input.accountScope,
      sourceId,
      messageId,
      input.senderAddress,
      input.smtpHost,
      input.smtpPort,
      input.smtpSecurity,
      input.smtpUsername,
      input.credentialRefId,
      input.targetAddress,
      ccJson,
      bccJson,
      input.idempotencyKey ?? null,
      input.payloadFingerprint,
      input.scheduledAt ?? null,
      input.scheduledAt ?? null,
      input.now,
      input.now,
    );

    const createdRow = readQueueRowById(database, queueId);
    if (!createdRow) {
      throw new Error("Send queue insert did not return a row.");
    }
    database.exec("COMMIT");
    return {
      messageId,
      queueItem: mapMailSendQueueRow(createdRow),
      deduplicated: false,
    };
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Ignore rollback failure.
    }
    throw error;
  }
}

export function reopenScheduledSendInDatabase(
  database: DatabaseSync,
  messageId: string,
  now: string,
): MailScheduledSendReopenResult {
  database.exec("BEGIN IMMEDIATE");
  try {
    const pendingRow = database.prepare(`
      SELECT id, cc_addresses_json, bcc_addresses_json
      FROM mail_send_queue
      WHERE message_id = ?
        AND status = 'queued'
        AND scheduled_at IS NOT NULL
      ORDER BY next_retry_at ASC, created_at ASC, id ASC
      LIMIT 1
    `).get(messageId) as unknown as {
      id: string;
      cc_addresses_json: string;
      bcc_addresses_json: string;
    } | undefined;

    if (!pendingRow) {
      throw new EasyEmailError(
        "SCHEDULED_SEND_NOT_PENDING",
        "This scheduled send is no longer pending.",
      );
    }

    const cancelled = database.prepare(`
      UPDATE mail_send_queue
      SET status = 'cancelled',
          next_retry_at = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error_code = 'SCHEDULED_SEND_CANCELLED',
          last_error_message = 'Scheduled send was reopened for editing.',
          version = version + 1,
          updated_at = ?
      WHERE id = ?
        AND status = 'queued'
        AND scheduled_at IS NOT NULL
    `).run(now, pendingRow.id);
    if (Number(cancelled.changes) === 0) {
      throw new EasyEmailError(
        "SCHEDULED_SEND_NOT_PENDING",
        "This scheduled send is no longer pending.",
      );
    }

    const updatedMessage = database.prepare(`
      UPDATE mail_messages
      SET observed_at = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND deleted_at IS NULL
    `).run(now, now, messageId);
    if (Number(updatedMessage.changes) === 0) {
      throw new EasyEmailError("MAIL_MESSAGE_NOT_FOUND", `Message ${messageId} was not found.`);
    }

    const updatedSource = database.prepare(`
      UPDATE mail_message_sources
      SET source_kind = 'local_draft',
          source_ref_id = 'draft:' || COALESCE(account_id, ''),
          lifecycle_state = 'draft',
          is_read = 1,
          local_folder = 'drafts',
          labels_json = '[]',
          draft_cc_json = ?,
          draft_bcc_json = ?,
          last_seen_at = ?
      WHERE message_id = ?
    `).run(pendingRow.cc_addresses_json, pendingRow.bcc_addresses_json, now, messageId);
    if (Number(updatedSource.changes) === 0) {
      throw new EasyEmailError("MAIL_MESSAGE_NOT_FOUND", `Message ${messageId} was not found.`);
    }

    const messageRow = database.prepare(`
      SELECT ${MESSAGE_SELECT_COLUMNS}
      FROM mail_messages m
      INNER JOIN mail_message_sources s ON s.message_id = m.id
      WHERE m.id = ? AND m.deleted_at IS NULL
      ORDER BY s.first_seen_at ASC, s.id ASC
      LIMIT 1
    `).get(messageId) as unknown as RawMailMessageRow | undefined;
    const queueRow = readQueueRowById(database, pendingRow.id);
    if (!messageRow || !queueRow) {
      throw new EasyEmailError("MAIL_MESSAGE_NOT_FOUND", `Message ${messageId} was not found.`);
    }

    database.exec("COMMIT");
    return {
      message: mapMailMessageDetailRow(messageRow).detail,
      queueItem: mapMailSendQueueRow(queueRow),
    };
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Ignore rollback failure.
    }
    throw error;
  }
}
