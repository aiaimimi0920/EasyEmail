import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  MailImapFolder,
  MailImapFolderIngestInput,
  MailImapFolderIngestResult,
  MailImapFolderKind,
  MailImapMessageSourceContext,
  MailImapRemoteFolder,
  MailImapRepository,
  MailImapStoredCheckpoint,
} from "../../domain/mail-imap-sync.js";
import { ingestImapFolderHeadersInDatabase } from "./mail-imap-ingest-persistence.js";

interface RawImapFolderRow {
  id: string;
  account_id: string;
  source_ref_id: string;
  provider_folder_id: string;
  display_name: string;
  path: string;
  delimiter: string;
  folder_kind: MailImapFolderKind;
  special_use: string | null;
  uid_validity: string | null;
  last_seen_uid: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RawCheckpointRow {
  account_id: string;
  sync_state: MailImapStoredCheckpoint["syncState"];
  last_attempt_at: string | null;
  last_synced_at: string | null;
  last_fetched_count: number;
  last_inserted_count: number;
  last_error_code: string | null;
  last_error_message: string | null;
  updated_at: string;
}

function mapImapFolderRow(row: RawImapFolderRow): MailImapFolder {
  return {
    id: row.id,
    accountId: row.account_id,
    sourceRefId: row.source_ref_id,
    providerFolderId: row.provider_folder_id,
    displayName: row.display_name,
    path: row.path,
    delimiter: row.delimiter,
    folderKind: row.folder_kind,
    ...(row.special_use ? { specialUse: row.special_use } : {}),
    ...(row.uid_validity ? { uidValidity: row.uid_validity } : {}),
    ...(row.last_seen_uid ? { lastSeenUid: row.last_seen_uid } : {}),
    ...(row.last_synced_at ? { lastSyncedAt: row.last_synced_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteMailImapRepository implements MailImapRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public async upsertImapFolders(
    accountId: string,
    sourceRefId: string,
    folders: MailImapRemoteFolder[],
    now: string,
  ): Promise<MailImapFolder[]> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const folder of folders) {
        const existing = this.database.prepare(`
          SELECT id FROM mail_imap_folders
          WHERE account_id = ? AND provider_folder_id = ?
          LIMIT 1
        `).get(accountId, folder.providerFolderId) as unknown as { id: string } | undefined;

        const folderId = existing?.id ?? `fld_v1_${randomUUID()}`;
        this.database.prepare(`
          INSERT INTO mail_imap_folders (
            id, account_id, source_ref_id, provider_folder_id, display_name,
            path, delimiter, folder_kind, special_use, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(account_id, provider_folder_id) DO UPDATE SET
            display_name = excluded.display_name,
            path = excluded.path,
            delimiter = excluded.delimiter,
            folder_kind = excluded.folder_kind,
            special_use = excluded.special_use,
            updated_at = excluded.updated_at
        `).run(
          folderId,
          accountId,
          sourceRefId,
          folder.providerFolderId,
          folder.displayName,
          folder.path,
          folder.delimiter || "/",
          folder.folderKind,
          folder.specialUse ?? null,
          now,
          now,
        );
      }

      if (folders.length > 0) {
        const activeProviderIds = new Set(folders.map((item) => item.providerFolderId));
        const existingRows = this.database.prepare(`
          SELECT id, provider_folder_id FROM mail_imap_folders WHERE account_id = ?
        `).all(accountId) as unknown as Array<{ id: string; provider_folder_id: string }>;
        for (const row of existingRows) {
          if (!activeProviderIds.has(row.provider_folder_id)) {
            this.database.prepare(`
              UPDATE mail_message_sources SET imap_folder_id = NULL WHERE imap_folder_id = ?
            `).run(row.id);
            this.database.prepare(`
              DELETE FROM mail_imap_folders WHERE id = ?
            `).run(row.id);
          }
        }
      }
      this.database.exec("COMMIT");
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Ignore rollback failure.
      }
      throw error;
    }

    return this.listImapFolders(accountId);
  }

  public async listImapFolders(accountId: string): Promise<MailImapFolder[]> {
    const rows = this.database.prepare(`
      SELECT
        id, account_id, source_ref_id, provider_folder_id, display_name,
        path, delimiter, folder_kind, special_use, uid_validity,
        last_seen_uid, last_synced_at, created_at, updated_at
      FROM mail_imap_folders
      WHERE account_id = ?
      ORDER BY
        CASE folder_kind
          WHEN 'inbox' THEN 0
          WHEN 'sent' THEN 1
          WHEN 'drafts' THEN 2
          WHEN 'archive' THEN 3
          WHEN 'spam' THEN 4
          WHEN 'trash' THEN 5
          ELSE 6
        END ASC,
        display_name COLLATE NOCASE ASC,
        id ASC
    `).all(accountId) as unknown as RawImapFolderRow[];
    return rows.map(mapImapFolderRow);
  }

  public async ingestImapFolderBatch(
    input: MailImapFolderIngestInput,
  ): Promise<MailImapFolderIngestResult> {
    return ingestImapFolderHeadersInDatabase(this.database, input);
  }

  public async getSyncCheckpoint(accountId: string): Promise<MailImapStoredCheckpoint | undefined> {
    const row = this.database.prepare(`
      SELECT
        account_id, sync_state, last_attempt_at, last_synced_at,
        last_fetched_count, last_inserted_count, last_error_code,
        last_error_message, updated_at
      FROM mail_account_sync_checkpoints
      WHERE account_id = ?
      LIMIT 1
    `).get(accountId) as unknown as RawCheckpointRow | undefined;
    if (!row) {
      return undefined;
    }
    return {
      accountId: row.account_id,
      syncState: row.sync_state,
      ...(row.last_attempt_at ? { lastAttemptAt: row.last_attempt_at } : {}),
      ...(row.last_synced_at ? { lastSyncedAt: row.last_synced_at } : {}),
      lastFetchedCount: Number(row.last_fetched_count),
      lastInsertedCount: Number(row.last_inserted_count),
      ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
      ...(row.last_error_message ? { lastErrorMessage: row.last_error_message } : {}),
      updatedAt: row.updated_at,
    };
  }

  public async upsertSyncCheckpoint(input: MailImapStoredCheckpoint): Promise<void> {
    this.database.prepare(`
      INSERT INTO mail_account_sync_checkpoints (
        account_id, sync_state, last_attempt_at, last_synced_at,
        last_fetched_count, last_inserted_count, last_error_code,
        last_error_message, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        sync_state = excluded.sync_state,
        last_attempt_at = COALESCE(excluded.last_attempt_at, mail_account_sync_checkpoints.last_attempt_at),
        last_synced_at = COALESCE(excluded.last_synced_at, mail_account_sync_checkpoints.last_synced_at),
        last_fetched_count = excluded.last_fetched_count,
        last_inserted_count = excluded.last_inserted_count,
        last_error_code = excluded.last_error_code,
        last_error_message = excluded.last_error_message,
        updated_at = excluded.updated_at
    `).run(
      input.accountId,
      input.syncState,
      input.lastAttemptAt ?? null,
      input.lastSyncedAt ?? null,
      input.lastFetchedCount,
      input.lastInsertedCount,
      input.lastErrorCode ?? null,
      input.lastErrorMessage ?? null,
      input.updatedAt,
    );
  }

  public async getImapMessageSourceContext(
    messageId: string,
  ): Promise<MailImapMessageSourceContext | undefined> {
    const row = this.database.prepare(`
      SELECT
        s.id AS source_row_id,
        s.message_id AS message_id,
        s.account_id AS account_id,
        s.source_ref_id AS source_ref_id,
        s.imap_folder_id AS folder_id,
        f.path AS folder_path,
        f.folder_kind AS folder_kind,
        s.imap_uid AS imap_uid,
        s.imap_uid_validity AS imap_uid_validity,
        m.body_cache_state AS body_cache_state
      FROM mail_message_sources s
      INNER JOIN mail_messages m ON m.id = s.message_id
      INNER JOIN mail_imap_folders f ON f.id = s.imap_folder_id
      WHERE s.message_id = ?
        AND m.deleted_at IS NULL
        AND s.source_kind = 'imap'
        AND s.account_id IS NOT NULL
        AND s.imap_uid IS NOT NULL
      ORDER BY s.first_seen_at ASC, s.id ASC
      LIMIT 1
    `).get(messageId) as unknown as {
      source_row_id: string;
      message_id: string;
      account_id: string;
      source_ref_id: string;
      folder_id: string;
      folder_path: string;
      folder_kind: MailImapFolderKind;
      imap_uid: string;
      imap_uid_validity: string | null;
      body_cache_state: "none" | "cached";
    } | undefined;

    if (!row) {
      return undefined;
    }
    return {
      sourceRowId: row.source_row_id,
      messageId: row.message_id,
      accountId: row.account_id,
      sourceRefId: row.source_ref_id,
      folderId: row.folder_id,
      folderPath: row.folder_path,
      folderKind: row.folder_kind,
      imapUid: row.imap_uid,
      ...(row.imap_uid_validity ? { imapUidValidity: row.imap_uid_validity } : {}),
      bodyCacheState: row.body_cache_state,
    };
  }

  public async cacheMailMessageBody(
    messageId: string,
    bodyText: string,
    bodyHtml: string | undefined,
    snippet: string,
    hasAttachments: boolean,
    now: string,
  ): Promise<void> {
    this.database.prepare(`
      UPDATE mail_messages
      SET body_text = ?,
          body_html = ?,
          snippet = CASE WHEN ? != '' THEN ? ELSE snippet END,
          body_cache_state = 'cached',
          has_attachments = CASE WHEN ? = 1 THEN 1 ELSE has_attachments END,
          version = version + 1,
          updated_at = ?
      WHERE id = ? AND deleted_at IS NULL
    `).run(
      bodyText,
      bodyHtml ?? null,
      snippet,
      snippet,
      hasAttachments ? 1 : 0,
      now,
      messageId,
    );
  }

  public async updateImapMessageSourceFolderAndUid(
    sourceRowId: string,
    targetFolderId: string,
    targetUid: string | undefined,
    targetUidValidity: string | undefined,
    now: string,
  ): Promise<void> {
    if (targetUid) {
      const validity = targetUidValidity?.trim() || "0";
      const externalMessageId = `${targetFolderId}:${validity}:${targetUid}`;
      this.database.prepare(`
        UPDATE mail_message_sources
        SET imap_folder_id = ?, imap_uid = ?, imap_uid_validity = ?,
            external_message_id = ?, last_seen_at = ?
        WHERE id = ?
      `).run(targetFolderId, targetUid, validity, externalMessageId, now, sourceRowId);
      return;
    }

    this.database.prepare(`
      UPDATE mail_message_sources
      SET imap_folder_id = ?, imap_uid = NULL, imap_uid_validity = NULL, last_seen_at = ?
      WHERE id = ?
    `).run(targetFolderId, now, sourceRowId);
  }
}
