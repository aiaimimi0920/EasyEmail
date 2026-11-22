import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  MailImapFolderIngestInput,
  MailImapFolderIngestResult,
  MailImapFolderKind,
  MailImapRemoteMessageHeader,
} from "../../domain/mail-imap-sync.js";

function normalizeThreadSubject(subject: string): string {
  let normalized = subject.trim().toLowerCase();
  while (true) {
    const prefix = ["re:", "fwd:", "fw:", "回复:", "答复:", "转发:"].find((candidate) =>
      normalized.startsWith(candidate),
    );
    if (!prefix) break;
    normalized = normalized.slice(prefix.length).trim();
  }
  return normalized.replace(/\s+/gu, " ");
}

function normalizeThreadAddress(address: string): string {
  const trimmed = address.trim().toLowerCase();
  const open = trimmed.lastIndexOf("<");
  const close = trimmed.lastIndexOf(">");
  if (open >= 0 && open < close) {
    return trimmed.slice(open + 1, close).trim();
  }
  return trimmed;
}

function computeImapThreadKey(
  database: DatabaseSync,
  header: MailImapRemoteMessageHeader,
): string | undefined {
  const rootReference = header.references[0]?.trim();
  if (rootReference) {
    return `rfc:${rootReference}`;
  }

  const parentId = header.inReplyTo?.trim();
  if (parentId) {
    const existing = database.prepare(`
      SELECT thread_key
      FROM mail_messages
      WHERE rfc_message_id IS NOT NULL
        AND lower(rfc_message_id) = lower(?)
        AND thread_key IS NOT NULL
        AND trim(thread_key) != ''
        AND deleted_at IS NULL
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `).get(parentId) as unknown as { thread_key: string } | undefined;
    return existing?.thread_key || `rfc:${parentId}`;
  }

  const messageId = header.rfcMessageId?.trim();
  if (messageId) {
    return `rfc:${messageId}`;
  }

  const subject = normalizeThreadSubject(header.subject);
  const sender = normalizeThreadAddress(header.fromAddress);
  if (!subject && !sender) {
    return undefined;
  }
  return `subject:${subject}::from:${sender}`;
}

function initialLocalFolderForKind(folderKind: MailImapFolderKind): {
  localFolder: string;
  isArchived: number;
} {
  if (folderKind === "spam" || folderKind === "trash" || folderKind === "sent" || folderKind === "drafts") {
    return { localFolder: folderKind, isArchived: 0 };
  }
  if (folderKind === "archive") {
    return { localFolder: "archive", isArchived: 1 };
  }
  return { localFolder: "inbox", isArchived: 0 };
}

function buildImapExternalMessageId(folderId: string, uidValidity: string, uid: string): string {
  return `${folderId}:${uidValidity}:${uid}`;
}

export function ingestImapFolderHeadersInDatabase(
  database: DatabaseSync,
  input: MailImapFolderIngestInput,
): MailImapFolderIngestResult {
  const { accountId, sourceRefId, receivedAddress, providerLabel, folder, batch, now } = input;
  const uidValidity = batch.uidValidity.trim() || "0";

  database.exec("BEGIN IMMEDIATE");
  try {
    if (batch.uidValidityChanged) {
      database.prepare(`
        UPDATE mail_imap_folders
        SET uid_validity = ?, last_seen_uid = NULL, updated_at = ?
        WHERE id = ?
      `).run(uidValidity, now, folder.id);
    }

    let insertedCount = 0;
    const insertedMessageIds: string[] = [];

    for (const header of batch.headers) {
      if (header.isDeleted) {
        continue;
      }
      const externalMessageId = buildImapExternalMessageId(folder.id, uidValidity, header.uid);
      const computedThreadKey = computeImapThreadKey(database, header);

      const existingByUid = database.prepare(`
        SELECT s.id AS source_row_id, s.message_id AS message_id, m.rfc_message_id AS rfc_message_id,
               m.thread_key AS thread_key, m.deleted_at AS deleted_at
        FROM mail_message_sources s
        INNER JOIN mail_messages m ON m.id = s.message_id
        WHERE s.source_kind = 'imap'
          AND s.source_ref_id = ?
          AND s.external_message_id = ?
        LIMIT 1
      `).get(sourceRefId, externalMessageId) as unknown as {
        source_row_id: string;
        message_id: string;
        rfc_message_id: string | null;
        thread_key: string | null;
        deleted_at: string | null;
      } | undefined;

      if (existingByUid) {
        database.prepare(`
          UPDATE mail_messages
          SET subject = ?, from_address = ?, from_name = COALESCE(?, from_name),
              observed_at = ?, snippet = CASE WHEN body_cache_state = 'cached' THEN snippet ELSE ? END,
              rfc_message_id = COALESCE(?, rfc_message_id),
              thread_key = COALESCE(?, thread_key),
              has_attachments = CASE WHEN ? = 1 THEN 1 ELSE has_attachments END,
              updated_at = ?
          WHERE id = ?
        `).run(
          header.subject,
          header.fromAddress,
          header.fromName ?? null,
          header.observedAt,
          header.snippet,
          header.rfcMessageId ?? null,
          computedThreadKey ?? null,
          header.hasAttachments ? 1 : 0,
          now,
          existingByUid.message_id,
        );
        database.prepare(`
          UPDATE mail_message_sources
          SET is_read = ?, is_starred = ?, provider_label = ?, last_seen_at = ?
          WHERE id = ?
        `).run(
          header.isRead ? 1 : 0,
          header.isStarred ? 1 : 0,
          providerLabel,
          now,
          existingByUid.source_row_id,
        );
        continue;
      }

      const normalizedRfcId = header.rfcMessageId?.trim() || undefined;
      const matchedByRfc = normalizedRfcId
        ? (database.prepare(`
            SELECT m.id AS id
            FROM mail_messages m
            WHERE lower(m.rfc_message_id) = lower(?)
              AND m.deleted_at IS NULL
              AND EXISTS (
                SELECT 1
                FROM mail_message_sources s2
                LEFT JOIN mail_accounts a2 ON a2.id = s2.account_id
                WHERE s2.message_id = m.id
                  AND (s2.account_id IS NULL OR a2.scope != 'agent')
              )
            ORDER BY m.created_at ASC, m.id ASC
            LIMIT 1
          `).get(normalizedRfcId) as unknown as { id: string } | undefined)
        : undefined;

      const messageId = matchedByRfc?.id ?? `msg_v1_${randomUUID()}`;
      if (!matchedByRfc) {
        database.prepare(`
          INSERT INTO mail_messages (
            id, rfc_message_id, thread_key, subject, from_address, from_name,
            snippet, body_text, body_html, body_cache_state, has_attachments,
            classification, observed_at, version, created_at, updated_at, deleted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'none', ?, ?, ?, 1, ?, ?, NULL)
        `).run(
          messageId,
          normalizedRfcId ?? null,
          computedThreadKey ?? null,
          header.subject,
          header.fromAddress,
          header.fromName ?? null,
          header.snippet,
          header.hasAttachments ? 1 : 0,
          header.isNewsletter ? "newsletter" : "general",
          header.observedAt,
          now,
          now,
        );
      }

      const existingAccountSource = database.prepare(`
        SELECT id FROM mail_message_sources
        WHERE message_id = ? AND source_kind = 'imap' AND source_ref_id = ?
        LIMIT 1
      `).get(messageId, sourceRefId) as unknown as { id: string } | undefined;

      if (existingAccountSource) {
        database.prepare(`
          UPDATE mail_message_sources
          SET external_message_id = ?, imap_folder_id = ?, imap_uid = ?, imap_uid_validity = ?,
              is_read = ?, is_starred = ?, provider_label = ?, last_seen_at = ?
          WHERE id = ?
        `).run(
          externalMessageId,
          folder.id,
          header.uid,
          uidValidity,
          header.isRead ? 1 : 0,
          header.isStarred ? 1 : 0,
          providerLabel,
          now,
          existingAccountSource.id,
        );
      } else {
        const { localFolder, isArchived } = initialLocalFolderForKind(folder.folderKind);
        const labelsJson = header.isNewsletter ? '["newsletters"]' : "[]";
        database.prepare(`
          INSERT INTO mail_message_sources (
            id, message_id, source_kind, source_ref_id, account_id, session_id,
            provider_instance_id, external_message_id, received_address, provider_label,
            lifecycle_state, is_read, is_starred, is_archived, is_important,
            local_folder, labels_json, draft_cc_json, draft_bcc_json,
            first_seen_at, last_seen_at, imap_folder_id, imap_uid, imap_uid_validity
          ) VALUES (?, ?, 'imap', ?, ?, NULL, NULL, ?, ?, ?, 'active', ?, ?, ?, 0, ?, ?, '[]', '[]', ?, ?, ?, ?, ?)
        `).run(
          `msrc_v1_${randomUUID()}`,
          messageId,
          sourceRefId,
          accountId,
          externalMessageId,
          receivedAddress,
          providerLabel,
          header.isRead ? 1 : 0,
          header.isStarred ? 1 : 0,
          isArchived,
          localFolder,
          labelsJson,
          now,
          now,
          folder.id,
          header.uid,
          uidValidity,
        );
        insertedCount += 1;
        insertedMessageIds.push(messageId);
      }
    }

    const nextSeenUid = chooseMaxNumericUid(
      batch.uidValidityChanged ? undefined : folder.lastSeenUid,
      batch.highestSeenUid,
    );
    database.prepare(`
      UPDATE mail_imap_folders
      SET uid_validity = ?, last_seen_uid = ?, last_synced_at = ?, updated_at = ?
      WHERE id = ?
    `).run(uidValidity, nextSeenUid ?? null, now, now, folder.id);

    database.exec("COMMIT");
    return {
      fetchedCount: batch.headers.length,
      insertedCount,
      insertedMessageIds,
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

function chooseMaxNumericUid(left?: string, right?: string): string | undefined {
  const leftNum = left && /^\d+$/u.test(left) ? BigInt(left) : undefined;
  const rightNum = right && /^\d+$/u.test(right) ? BigInt(right) : undefined;
  if (leftNum !== undefined && rightNum !== undefined) {
    return leftNum >= rightNum ? left : right;
  }
  return right ?? left;
}
