import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { EasyEmailError } from "../../domain/errors.js";
import type {
  MailDraftRepositoryUpsertInput,
  MailDraftSaveResult,
} from "../../domain/mail-message.js";

export function upsertLocalDraftInDatabase(
  database: DatabaseSync,
  input: MailDraftRepositoryUpsertInput,
): MailDraftSaveResult {
  database.exec("BEGIN IMMEDIATE");
  try {
    const existing = input.draftId
      ? (database.prepare(`
          SELECT m.id AS message_id, m.version AS version,
                 s.id AS source_id, s.source_kind AS source_kind, s.account_id AS account_id
          FROM mail_messages m
          LEFT JOIN mail_message_sources s ON s.message_id = m.id
          WHERE m.id = ?
          ORDER BY s.first_seen_at ASC, s.id ASC
          LIMIT 1
        `).get(input.draftId) as unknown as {
          message_id: string;
          version: number;
          source_id: string | null;
          source_kind: string | null;
          account_id: string | null;
        } | undefined)
      : undefined;

    if (
      existing
      && (existing.source_kind !== "local_draft" || existing.account_id !== input.accountId)
    ) {
      throw new EasyEmailError(
        "MAIL_DRAFT_CONFLICT",
        "Draft identifier belongs to another message or account.",
      );
    }

    const messageId = existing?.message_id ?? input.draftId ?? `msg_v1_${randomUUID()}`;
    const nextVersion = existing ? existing.version + 1 : 1;
    const ccJson = JSON.stringify(input.ccAddresses);
    const bccJson = JSON.stringify(input.bccAddresses);

    if (existing) {
      database.prepare(`
        UPDATE mail_messages
        SET subject = ?, from_address = ?, from_name = ?, snippet = ?,
            body_text = ?, body_html = ?, body_cache_state = 'cached',
            classification = 'outgoing', observed_at = ?, version = ?,
            updated_at = ?, deleted_at = NULL
        WHERE id = ?
      `).run(
        input.subject,
        input.fromAddress,
        input.fromName ?? null,
        input.snippet,
        input.bodyText,
        input.bodyHtml ?? null,
        input.now,
        nextVersion,
        input.now,
        messageId,
      );
    } else {
      database.prepare(`
        INSERT INTO mail_messages (
          id, rfc_message_id, thread_key, subject, from_address, from_name,
          snippet, body_text, body_html, body_cache_state, has_attachments,
          classification, observed_at, version, created_at, updated_at, deleted_at
        ) VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, 'cached', 0, 'outgoing', ?, 1, ?, ?, NULL)
      `).run(
        messageId,
        input.subject,
        input.fromAddress,
        input.fromName ?? null,
        input.snippet,
        input.bodyText,
        input.bodyHtml ?? null,
        input.now,
        input.now,
        input.now,
      );
    }

    if (existing?.source_id) {
      database.prepare(`
        UPDATE mail_message_sources
        SET received_address = ?, provider_label = ?, lifecycle_state = 'draft',
            is_read = 1, is_archived = 0, local_folder = 'drafts',
            draft_cc_json = ?, draft_bcc_json = ?, last_seen_at = ?
        WHERE id = ?
      `).run(
        input.targetAddress,
        input.providerLabel,
        ccJson,
        bccJson,
        input.now,
        existing.source_id,
      );
    } else {
      database.prepare(`
        INSERT INTO mail_message_sources (
          id, message_id, source_kind, source_ref_id, account_id, session_id,
          provider_instance_id, external_message_id, received_address, provider_label,
          lifecycle_state, is_read, is_starred, is_archived, is_important,
          local_folder, labels_json, draft_cc_json, draft_bcc_json, first_seen_at, last_seen_at
        ) VALUES (?, ?, 'local_draft', ?, ?, NULL, NULL, NULL, ?, ?, 'draft', 1, 0, 0, 0, 'drafts', '[]', ?, ?, ?, ?)
      `).run(
        `msrc_v1_${randomUUID()}`,
        messageId,
        `draft:${input.accountId}`,
        input.accountId,
        input.targetAddress,
        input.providerLabel,
        ccJson,
        bccJson,
        input.now,
        input.now,
      );
    }

    database.exec("COMMIT");
    return {
      messageId,
      accountId: input.accountId,
      savedAt: input.now,
      version: nextVersion,
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

export function deleteLocalDraftInDatabase(
  database: DatabaseSync,
  id: string,
  now: string,
): boolean {
  const result = database.prepare(`
    UPDATE mail_messages
    SET deleted_at = ?, updated_at = ?, version = version + 1
    WHERE id = ?
      AND deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM mail_message_sources s
        WHERE s.message_id = mail_messages.id
          AND (s.source_kind = 'local_draft' OR s.local_folder = 'drafts')
      )
  `).run(now, now, id);
  return Number(result.changes) > 0;
}
