import { DatabaseSync } from "node:sqlite";

import type {
  MailDraftRepositoryUpsertInput,
  MailDraftSaveResult,
  MailMessageClassification,
  MailMessageDetail,
  MailMessageDetailScope,
  MailMessageFlagName,
  MailMessageIngestInput,
  MailMessageIngestResult,
  MailMessageRepository,
  MailMessageRepositoryListQuery,
  MailMessageRepositoryListResult,
  MailVerificationAccountScope,
  StoredMessageVerificationSource,
} from "../../domain/mail-message.js";
import {
  deleteLocalDraftInDatabase,
  upsertLocalDraftInDatabase,
} from "./mail-draft-persistence.js";
import { ingestMailMessageInDatabase } from "./mail-message-ingest-persistence.js";
import {
  buildDetailSourceScopeCondition,
  buildListMailMessagesSql,
  MESSAGE_SELECT_COLUMNS,
} from "./mail-message-query-sql.js";
import {
  mapMailMessageDetailRow,
  mapMailMessageSummaryRow,
  parseStringArrayJson,
  type RawMailMessageRow,
} from "./mail-message-row-mapper.js";

export class SqliteMailMessageRepository implements MailMessageRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public async ingestMailMessage(input: MailMessageIngestInput): Promise<MailMessageIngestResult> {
    return ingestMailMessageInDatabase(this.database, input);
  }

  public async listMailMessages(
    query: MailMessageRepositoryListQuery,
  ): Promise<MailMessageRepositoryListResult> {
    const { sql, params } = buildListMailMessagesSql(query);
    const rows = this.database.prepare(sql).all(...params) as unknown as RawMailMessageRow[];
    const hasMore = rows.length > query.limit;
    return {
      messages: rows.slice(0, query.limit).map(mapMailMessageSummaryRow),
      hasMore,
    };
  }

  public async getMailMessageDetail(
    id: string,
    scope: MailMessageDetailScope = "normal",
  ): Promise<{ detail: MailMessageDetail; rawBodyHtml?: string } | undefined> {
    const scopeCondition = buildDetailSourceScopeCondition(scope);
    const row = this.database.prepare(`
      SELECT ${MESSAGE_SELECT_COLUMNS}
      FROM mail_messages m
      INNER JOIN mail_message_sources s ON s.message_id = m.id
      WHERE m.id = ?
        AND m.deleted_at IS NULL
        AND s.id = (
          SELECT s2.id
          FROM mail_message_sources s2
          LEFT JOIN mail_accounts a2 ON a2.id = s2.account_id
          WHERE s2.message_id = m.id
            AND (${scopeCondition})
          ORDER BY s2.first_seen_at ASC, s2.id ASC
          LIMIT 1
        )
      LIMIT 1
    `).get(id) as unknown as RawMailMessageRow | undefined;

    return row ? mapMailMessageDetailRow(row) : undefined;
  }

  public async upsertLocalDraft(
    input: MailDraftRepositoryUpsertInput,
  ): Promise<MailDraftSaveResult> {
    return upsertLocalDraftInDatabase(this.database, input);
  }

  public async deleteLocalDraft(id: string, now: string): Promise<boolean> {
    return deleteLocalDraftInDatabase(this.database, id, now);
  }

  private messageIsLive(id: string): boolean {
    const row = this.database.prepare(
      "SELECT 1 AS ok FROM mail_messages WHERE id = ? AND deleted_at IS NULL LIMIT 1",
    ).get(id) as unknown as { ok: number } | undefined;
    return Boolean(row?.ok);
  }

  public async setMailMessageLocalFlag(
    id: string,
    flagName: MailMessageFlagName,
    enabled: boolean,
    now: string,
  ): Promise<boolean | undefined> {
    if (!this.messageIsLive(id)) {
      return undefined;
    }
    const column = flagName === "read"
      ? "is_read"
      : flagName === "starred"
        ? "is_starred"
        : flagName === "archived"
          ? "is_archived"
          : "is_important";
    const bit = enabled ? 1 : 0;
    const result = this.database.prepare(`
      UPDATE mail_message_sources
      SET ${column} = ?, last_seen_at = ?
      WHERE message_id = ? AND ${column} != ?
    `).run(bit, now, id, bit);
    const changed = Number(result.changes) > 0;
    if (changed) {
      this.database.prepare(
        "UPDATE mail_messages SET updated_at = ?, version = version + 1 WHERE id = ?",
      ).run(now, id);
    }
    return changed;
  }

  public async setMailMessageLocalFolder(
    id: string,
    folderName: string,
    now: string,
  ): Promise<boolean | undefined> {
    if (!this.messageIsLive(id)) {
      return undefined;
    }
    const archivedBit = folderName === "archive" ? 1 : 0;
    const result = this.database.prepare(`
      UPDATE mail_message_sources
      SET local_folder = ?, is_archived = ?, last_seen_at = ?
      WHERE message_id = ? AND (local_folder != ? OR is_archived != ?)
    `).run(folderName, archivedBit, now, id, folderName, archivedBit);
    const changed = Number(result.changes) > 0;
    if (changed) {
      this.database.prepare(
        "UPDATE mail_messages SET updated_at = ?, version = version + 1 WHERE id = ?",
      ).run(now, id);
    }
    return changed;
  }

  public async setMailMessageLocalLabel(
    id: string,
    labelName: string,
    enabled: boolean,
    now: string,
  ): Promise<boolean | undefined> {
    if (!this.messageIsLive(id)) {
      return undefined;
    }
    const sources = this.database.prepare(
      "SELECT id, labels_json FROM mail_message_sources WHERE message_id = ?",
    ).all(id) as unknown as Array<{ id: string; labels_json: string }>;

    let changed = false;
    const targetLower = labelName.toLowerCase();
    for (const source of sources) {
      const current = parseStringArrayJson(source.labels_json);
      let next: string[];
      if (enabled) {
        if (current.some((item) => item.toLowerCase() === targetLower)) {
          continue;
        }
        next = [...current, labelName].sort((left, right) => left.localeCompare(right));
      } else {
        next = current.filter((item) => item.toLowerCase() !== targetLower);
        if (next.length === current.length) {
          continue;
        }
      }
      this.database.prepare(
        "UPDATE mail_message_sources SET labels_json = ?, last_seen_at = ? WHERE id = ?",
      ).run(JSON.stringify(next), now, source.id);
      changed = true;
    }
    if (changed) {
      this.database.prepare(
        "UPDATE mail_messages SET updated_at = ?, version = version + 1 WHERE id = ?",
      ).run(now, id);
    }
    return changed;
  }

  public async softDeleteMailMessage(id: string, now: string): Promise<boolean | undefined> {
    if (!this.messageIsLive(id)) {
      return undefined;
    }
    const result = this.database.prepare(
      "UPDATE mail_messages SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND deleted_at IS NULL",
    ).run(now, now, id);
    return Number(result.changes) > 0;
  }

  public async listTrashMessageIds(): Promise<string[]> {
    const rows = this.database.prepare(`
      SELECT DISTINCT m.id AS id
      FROM mail_messages m
      INNER JOIN mail_message_sources s ON s.message_id = m.id
      WHERE m.deleted_at IS NULL AND lower(s.local_folder) = 'trash'
      ORDER BY m.observed_at DESC, m.id DESC
    `).all() as unknown as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  public async promoteTemporarySessionMessages(
    sessionId: string,
    targetAccountId: string,
    now: string,
  ): Promise<number> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const sourceResult = this.database.prepare(`
        UPDATE mail_message_sources
        SET account_id = ?, last_seen_at = ?
        WHERE session_id = ? AND account_id IS NULL
      `).run(targetAccountId, now, sessionId);
      this.database.prepare(`
        UPDATE mail_verification_codes
        SET account_scope = 'promoted'
        WHERE session_id = ? AND account_scope = 'anonymous'
      `).run(sessionId);
      this.database.exec("COMMIT");
      return Number(sourceResult.changes);
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Ignore rollback failure.
      }
      throw error;
    }
  }

  public async getMessageForVerification(
    id: string,
  ): Promise<StoredMessageVerificationSource | undefined> {
    const row = this.database.prepare(`
      SELECT
        m.id AS message_id,
        m.subject AS subject,
        m.from_address AS from_address,
        m.snippet AS snippet,
        m.body_text AS body_text,
        m.body_html AS body_html,
        m.observed_at AS observed_at,
        m.classification AS classification,
        s.session_id AS session_id,
        s.source_ref_id AS source_ref_id,
        s.received_address AS received_address,
        s.account_id AS account_id,
        a.scope AS account_scope
      FROM mail_messages m
      INNER JOIN mail_message_sources s ON s.message_id = m.id
      LEFT JOIN mail_accounts a ON a.id = s.account_id
      WHERE m.id = ? AND m.deleted_at IS NULL
      ORDER BY s.first_seen_at ASC, s.id ASC
      LIMIT 1
    `).get(id) as unknown as {
      message_id: string;
      subject: string;
      from_address: string;
      snippet: string;
      body_text: string | null;
      body_html: string | null;
      observed_at: string;
      classification: MailMessageClassification;
      session_id: string | null;
      source_ref_id: string;
      received_address: string;
      account_id: string | null;
      account_scope: string | null;
    } | undefined;

    if (!row) {
      return undefined;
    }

    const accountScope: MailVerificationAccountScope = row.account_scope === "agent"
      ? "agent"
      : row.session_id && row.account_id
        ? "promoted"
        : row.account_id
          ? "normal"
          : "anonymous";

    return {
      messageId: row.message_id,
      accountScope,
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      sourceRefId: row.source_ref_id,
      receivedAddress: row.received_address,
      subject: row.subject,
      fromAddress: row.from_address,
      snippet: row.snippet,
      ...(row.body_text !== null ? { bodyText: row.body_text } : {}),
      ...(row.body_html !== null ? { bodyHtml: row.body_html } : {}),
      observedAt: row.observed_at,
      classification: row.classification,
    };
  }

  public async setMailMessageClassification(
    id: string,
    classification: MailMessageClassification,
    now: string,
  ): Promise<void> {
    this.database.prepare(
      "UPDATE mail_messages SET classification = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
    ).run(classification, now, id);
  }
}
