import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  MailMessageIngestInput,
  MailMessageIngestResult,
} from "../../domain/mail-message.js";

export function ingestMailMessageInDatabase(
  database: DatabaseSync,
  input: MailMessageIngestInput,
): MailMessageIngestResult {
  database.exec("BEGIN IMMEDIATE");
  try {
    if (input.externalMessageId) {
      const existingSource = database.prepare(`
        SELECT s.id AS source_id, s.message_id AS message_id, m.deleted_at AS deleted_at
        FROM mail_message_sources s
        INNER JOIN mail_messages m ON m.id = s.message_id
        WHERE s.source_kind = ? AND s.source_ref_id = ? AND s.external_message_id = ?
        LIMIT 1
      `).get(
        input.sourceKind,
        input.sourceRefId,
        input.externalMessageId,
      ) as unknown as { source_id: string; message_id: string; deleted_at: string | null } | undefined;

      if (existingSource) {
        database.prepare(`
          UPDATE mail_message_sources
          SET lifecycle_state = ?, provider_label = ?, last_seen_at = ?
          WHERE id = ?
        `).run(
          input.lifecycleState,
          input.providerLabel,
          input.now,
          existingSource.source_id,
        );
        database.exec("COMMIT");
        return {
          messageId: existingSource.message_id,
          insertedMessage: false,
          insertedSource: false,
          deleted: existingSource.deleted_at !== null,
        };
      }
    }

    const candidateById = input.messageId
      ? (database.prepare(
          "SELECT id, deleted_at FROM mail_messages WHERE id = ? LIMIT 1",
        ).get(input.messageId) as unknown as { id: string; deleted_at: string | null } | undefined)
      : undefined;

    const normalizedRfcId = input.rfcMessageId?.trim() || undefined;
    const isAgentSource = input.sourceKind === "agent";
    const candidateByRfc = !candidateById && normalizedRfcId
      ? (database.prepare(`
          SELECT m.id AS id, m.deleted_at AS deleted_at
          FROM mail_messages m
          WHERE lower(m.rfc_message_id) = lower(?)
            AND m.deleted_at IS NULL
            AND EXISTS (
              SELECT 1
              FROM mail_message_sources s2
              LEFT JOIN mail_accounts a2 ON a2.id = s2.account_id
              WHERE s2.message_id = m.id
                AND (
                  (? = 1 AND s2.account_id = ? AND a2.scope = 'agent')
                  OR (? = 0 AND (s2.account_id IS NULL OR a2.scope != 'agent'))
                )
            )
          ORDER BY m.created_at ASC, m.id ASC
          LIMIT 1
        `).get(
          normalizedRfcId,
          isAgentSource ? 1 : 0,
          input.accountId ?? "",
          isAgentSource ? 1 : 0,
        ) as unknown as { id: string; deleted_at: string | null } | undefined)
      : undefined;

    const matchedMessage = candidateById ?? candidateByRfc;
    const messageId = matchedMessage?.id ?? input.messageId ?? `msg_v1_${randomUUID()}`;
    let insertedMessage = false;

    if (!matchedMessage) {
      const hasBody = input.bodyText !== undefined || input.bodyHtml !== undefined;
      database.prepare(`
        INSERT INTO mail_messages (
          id, rfc_message_id, thread_key, subject, from_address, from_name,
          snippet, body_text, body_html, body_cache_state, has_attachments,
          classification, observed_at, version, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)
      `).run(
        messageId,
        normalizedRfcId ?? null,
        input.threadKey ?? null,
        input.subject,
        input.fromAddress,
        input.fromName ?? null,
        input.snippet,
        input.bodyText ?? null,
        input.bodyHtml ?? null,
        hasBody ? "cached" : "none",
        input.hasAttachments ? 1 : 0,
        input.classification ?? "general",
        input.observedAt,
        input.now,
        input.now,
      );
      insertedMessage = true;
    }

    const duplicateSourceOnSameMessage = database.prepare(`
      SELECT id FROM mail_message_sources
      WHERE message_id = ? AND source_kind = ? AND source_ref_id = ?
      LIMIT 1
    `).get(messageId, input.sourceKind, input.sourceRefId) as unknown as { id: string } | undefined;

    let insertedSource = false;
    if (duplicateSourceOnSameMessage) {
      database.prepare(`
        UPDATE mail_message_sources
        SET lifecycle_state = ?, provider_label = ?, last_seen_at = ?
        WHERE id = ?
      `).run(input.lifecycleState, input.providerLabel, input.now, duplicateSourceOnSameMessage.id);
    } else {
      database.prepare(`
        INSERT INTO mail_message_sources (
          id, message_id, source_kind, source_ref_id, account_id, session_id,
          provider_instance_id, external_message_id, received_address, provider_label,
          lifecycle_state, is_read, is_starred, is_archived, is_important,
          local_folder, labels_json, draft_cc_json, draft_bcc_json, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 'inbox', '[]', '[]', '[]', ?, ?)
      `).run(
        `msrc_v1_${randomUUID()}`,
        messageId,
        input.sourceKind,
        input.sourceRefId,
        input.accountId ?? null,
        input.sessionId ?? null,
        input.providerInstanceId ?? null,
        input.externalMessageId ?? null,
        input.receivedAddress,
        input.providerLabel,
        input.lifecycleState,
        input.now,
        input.now,
      );
      insertedSource = true;
    }

    database.exec("COMMIT");
    return {
      messageId,
      insertedMessage,
      insertedSource,
      deleted: Boolean(matchedMessage?.deleted_at),
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
