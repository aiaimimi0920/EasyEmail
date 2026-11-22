import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { EasyEmailError } from "../../domain/errors.js";
import type {
  MailScheduledSendReopenResult,
  MailSendEnqueueResult,
  MailSendQueueClaimedPayload,
  MailSendQueueItem,
  MailSendQueueRepository,
  MailSendQueueRepositoryEnqueueInput,
  MailSendQueueRepositoryListQuery,
  MailSendQueueRepositoryListResult,
} from "../../domain/mail-send-queue.js";
import { parseStringArrayJson } from "./mail-message-row-mapper.js";
import {
  enqueueOutgoingSendInDatabase,
  reopenScheduledSendInDatabase,
} from "./mail-send-queue-enqueue.js";
import {
  SEND_QUEUE_SELECT_COLUMNS,
  mapClaimedSendPayload,
  mapMailSendQueueRow,
  type RawMailSendQueueRow,
} from "./mail-send-queue-row-mapper.js";

const PENDING_SCHEDULED_LABEL = "未发送";

function hasAgentTables(database: DatabaseSync): boolean {
  const row = database.prepare(
    "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'mail_agent_messages' LIMIT 1",
  ).get() as { ok: number } | undefined;
  return Boolean(row?.ok);
}

function stripPendingLabel(rawLabelsJson: string): string {
  const labels = parseStringArrayJson(rawLabelsJson).filter(
    (label) => label !== PENDING_SCHEDULED_LABEL,
  );
  return JSON.stringify(labels);
}

export class SqliteMailSendQueueRepository implements MailSendQueueRepository {
  public constructor(private readonly database: DatabaseSync) {}

  private readRawById(id: string): RawMailSendQueueRow | undefined {
    return this.database.prepare(`
      SELECT ${SEND_QUEUE_SELECT_COLUMNS}
      FROM mail_send_queue q
      LEFT JOIN mail_messages m ON m.id = q.message_id
      WHERE q.id = ?
    `).get(id) as unknown as RawMailSendQueueRow | undefined;
  }

  public async enqueueOutgoingSend(
    input: MailSendQueueRepositoryEnqueueInput,
  ): Promise<MailSendEnqueueResult> {
    return enqueueOutgoingSendInDatabase(this.database, input);
  }

  public async listSendQueue(
    query: MailSendQueueRepositoryListQuery,
  ): Promise<MailSendQueueRepositoryListResult> {
    const conditions: string[] = ["1 = 1"];
    const params: SQLInputValue[] = [];
    if (query.accountId) {
      conditions.push("q.account_id = ?");
      params.push(query.accountId);
    }
    if (query.status) {
      conditions.push("q.status = ?");
      params.push(query.status);
    }
    if (query.after) {
      conditions.push("(q.created_at < ? OR (q.created_at = ? AND q.id < ?))");
      params.push(query.after.createdAt, query.after.createdAt, query.after.id);
    }
    params.push(query.limit + 1);
    const rows = this.database.prepare(`
      SELECT ${SEND_QUEUE_SELECT_COLUMNS}
      FROM mail_send_queue q
      LEFT JOIN mail_messages m ON m.id = q.message_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY q.created_at DESC, q.id DESC
      LIMIT ?
    `).all(...params) as unknown as RawMailSendQueueRow[];
    return {
      items: rows.slice(0, query.limit).map(mapMailSendQueueRow),
      hasMore: rows.length > query.limit,
    };
  }

  public async getSendQueueItem(id: string): Promise<MailSendQueueItem | undefined> {
    const row = this.readRawById(id);
    return row ? mapMailSendQueueRow(row) : undefined;
  }

  public async recoverStaleLeases(now: string): Promise<number> {
    const result = this.database.prepare(`
      UPDATE mail_send_queue
      SET status = 'delivery_unknown',
          attempt_count = attempt_count + 1,
          next_retry_at = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error_code = 'SMTP_DELIVERY_UNKNOWN',
          last_error_message = 'The service stopped or its send lease expired while delivering this message. Verify Sent before retrying.',
          version = version + 1,
          updated_at = ?
      WHERE status = 'sending'
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
    `).run(now, now);
    return Number(result.changes);
  }

  public async claimNextDueSend(
    leaseOwner: string,
    leaseExpiresAt: string,
    now: string,
  ): Promise<MailSendQueueClaimedPayload | undefined> {
    const claimed = this.database.prepare(`
      UPDATE mail_send_queue
      SET status = 'sending',
          lease_owner = ?,
          lease_expires_at = ?,
          version = version + 1,
          updated_at = ?
      WHERE id = (
        SELECT id
        FROM mail_send_queue
        WHERE status = 'queued'
          AND (next_retry_at IS NULL OR next_retry_at <= ?)
        ORDER BY COALESCE(next_retry_at, created_at) ASC, created_at ASC, id ASC
        LIMIT 1
      )
        AND status = 'queued'
      RETURNING id
    `).get(leaseOwner, leaseExpiresAt, now, now) as unknown as { id: string } | undefined;
    if (!claimed) return undefined;
    const row = this.readRawById(claimed.id);
    return row ? mapClaimedSendPayload(row) : undefined;
  }

  public async claimNextDueScheduledSend(
    leaseOwner: string,
    leaseExpiresAt: string,
    now: string,
  ): Promise<MailSendQueueClaimedPayload | undefined> {
    const claimed = this.database.prepare(`
      UPDATE mail_send_queue
      SET status = 'sending',
          lease_owner = ?,
          lease_expires_at = ?,
          version = version + 1,
          updated_at = ?
      WHERE id = (
        SELECT id
        FROM mail_send_queue
        WHERE status = 'queued'
          AND next_retry_at IS NOT NULL
          AND next_retry_at <= ?
        ORDER BY next_retry_at ASC, created_at ASC, id ASC
        LIMIT 1
      )
        AND status = 'queued'
      RETURNING id
    `).get(leaseOwner, leaseExpiresAt, now, now) as unknown as { id: string } | undefined;
    if (!claimed) return undefined;
    const row = this.readRawById(claimed.id);
    return row ? mapClaimedSendPayload(row) : undefined;
  }

  public async claimDueSendById(
    id: string,
    leaseOwner: string,
    leaseExpiresAt: string,
    now: string,
  ): Promise<MailSendQueueClaimedPayload | undefined> {
    const result = this.database.prepare(`
      UPDATE mail_send_queue
      SET status = 'sending',
          lease_owner = ?,
          lease_expires_at = ?,
          version = version + 1,
          updated_at = ?
      WHERE id = ?
        AND status = 'queued'
        AND (next_retry_at IS NULL OR next_retry_at <= ?)
    `).run(leaseOwner, leaseExpiresAt, now, id, now);
    if (Number(result.changes) === 0) return undefined;
    const row = this.readRawById(id);
    return row ? mapClaimedSendPayload(row) : undefined;
  }

  public async completeClaimedSendSent(
    id: string,
    leaseOwner: string,
    providerMessageId: string | undefined,
    now: string,
  ): Promise<MailSendQueueItem | undefined> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const updated = this.database.prepare(`
        UPDATE mail_send_queue
        SET status = 'sent',
            attempt_count = attempt_count + 1,
            next_retry_at = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            provider_message_id = COALESCE(?, provider_message_id),
            last_error_code = NULL,
            last_error_message = NULL,
            version = version + 1,
            updated_at = ?,
            sent_at = ?
        WHERE id = ?
          AND status = 'sending'
          AND lease_owner = ?
        RETURNING message_id
      `).get(providerMessageId ?? null, now, now, id, leaseOwner) as unknown as {
        message_id: string;
      } | undefined;
      if (!updated) {
        this.database.exec("ROLLBACK");
        return undefined;
      }

      this.database.prepare(`
        UPDATE mail_messages
        SET rfc_message_id = COALESCE(rfc_message_id, ?),
            observed_at = ?,
            updated_at = ?,
            version = version + 1
        WHERE id = ? AND deleted_at IS NULL
      `).run(providerMessageId ?? null, now, now, updated.message_id);

      if (hasAgentTables(this.database)) {
        this.database.prepare(`
          UPDATE mail_agent_messages
          SET parsed_status = 'sent'
          WHERE message_id = ? AND direction = 'outgoing'
        `).run(updated.message_id);
      }

      const sources = this.database.prepare(`
        SELECT id, labels_json
        FROM mail_message_sources
        WHERE message_id = ?
      `).all(updated.message_id) as unknown as Array<{ id: string; labels_json: string }>;
      const updateSourceStmt = this.database.prepare(`
        UPDATE mail_message_sources
        SET local_folder = 'sent',
            is_read = 1,
            labels_json = ?,
            last_seen_at = ?
        WHERE id = ?
      `);
      for (const source of sources) {
        updateSourceStmt.run(stripPendingLabel(source.labels_json), now, source.id);
      }

      this.database.exec("COMMIT");
      const row = this.readRawById(id);
      return row ? mapMailSendQueueRow(row) : undefined;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Ignore rollback failure.
      }
      throw error;
    }
  }

  public async completeClaimedSendRetry(
    id: string,
    leaseOwner: string,
    nextRetryAt: string,
    errorCode: string,
    errorMessage: string,
    now: string,
  ): Promise<MailSendQueueItem | undefined> {
    const result = this.database.prepare(`
      UPDATE mail_send_queue
      SET status = 'queued',
          attempt_count = attempt_count + 1,
          next_retry_at = ?,
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error_code = ?,
          last_error_message = ?,
          version = version + 1,
          updated_at = ?
      WHERE id = ?
        AND status = 'sending'
        AND lease_owner = ?
    `).run(nextRetryAt, errorCode, errorMessage, now, id, leaseOwner);
    if (Number(result.changes) === 0) return undefined;
    const row = this.readRawById(id);
    return row ? mapMailSendQueueRow(row) : undefined;
  }

  public async completeClaimedSendFailed(
    id: string,
    leaseOwner: string,
    terminalStatus: "failed" | "auth_failed",
    errorCode: string,
    errorMessage: string,
    now: string,
  ): Promise<MailSendQueueItem | undefined> {
    const result = this.database.prepare(`
      UPDATE mail_send_queue
      SET status = ?,
          attempt_count = attempt_count + 1,
          next_retry_at = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error_code = ?,
          last_error_message = ?,
          version = version + 1,
          updated_at = ?
      WHERE id = ?
        AND status = 'sending'
        AND lease_owner = ?
      RETURNING message_id
    `).get(terminalStatus, errorCode, errorMessage, now, id, leaseOwner) as unknown as {
      message_id: string;
    } | undefined;
    if (!result) return undefined;
    if (hasAgentTables(this.database)) {
      this.database.prepare(`
        UPDATE mail_agent_messages
        SET parsed_status = ?
        WHERE message_id = ? AND direction = 'outgoing'
      `).run(terminalStatus, result.message_id);
      this.database.prepare(`
        UPDATE mail_agent_threads
        SET status = 'failed', updated_at = ?
        WHERE last_outgoing_message_id = ? AND status = 'awaiting_reply'
      `).run(now, result.message_id);
    }
    const row = this.readRawById(id);
    return row ? mapMailSendQueueRow(row) : undefined;
  }

  public async cancelQueuedSend(
    id: string,
    expectedVersion: number | undefined,
    now: string,
  ): Promise<MailSendQueueItem | undefined> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.readRawById(id);
      if (!current) {
        this.database.exec("ROLLBACK");
        return undefined;
      }
      if (expectedVersion !== undefined && current.version !== expectedVersion) {
        throw new EasyEmailError("SEND_QUEUE_VERSION_CONFLICT", "Send queue item was modified by another request.");
      }
      if (current.status !== "queued") {
        throw new EasyEmailError(
          "SEND_QUEUE_CANCEL_CONFLICT",
          `Cannot cancel send queue item in status ${current.status}.`,
        );
      }
      const result = this.database.prepare(`
        UPDATE mail_send_queue
        SET status = 'cancelled',
            next_retry_at = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error_code = 'SEND_CANCELLED',
            last_error_message = 'Queued send was cancelled.',
            version = version + 1,
            updated_at = ?
        WHERE id = ? AND status = 'queued' AND version = ?
      `).run(now, id, current.version);
      if (Number(result.changes) === 0) {
        throw new EasyEmailError("SEND_QUEUE_VERSION_CONFLICT", "Send queue item was modified by another request.");
      }
      const sources = this.database.prepare(`
        SELECT id, labels_json FROM mail_message_sources WHERE message_id = ?
      `).all(current.message_id) as unknown as Array<{ id: string; labels_json: string }>;
      const updateSourceStmt = this.database.prepare(`
        UPDATE mail_message_sources SET labels_json = ?, last_seen_at = ? WHERE id = ?
      `);
      for (const source of sources) {
        updateSourceStmt.run(stripPendingLabel(source.labels_json), now, source.id);
      }
      this.database.exec("COMMIT");
      const updated = this.readRawById(id);
      return updated ? mapMailSendQueueRow(updated) : undefined;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Ignore rollback failure.
      }
      throw error;
    }
  }

  public async retryTerminalSend(
    id: string,
    expectedVersion: number | undefined,
    allowDeliveryUnknown: boolean,
    now: string,
  ): Promise<MailSendQueueItem | undefined> {
    const current = this.readRawById(id);
    if (!current) return undefined;
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new EasyEmailError("SEND_QUEUE_VERSION_CONFLICT", "Send queue item was modified by another request.");
    }
    if (current.status === "delivery_unknown" && !allowDeliveryUnknown) {
      throw new EasyEmailError(
        "SEND_DELIVERY_UNKNOWN_CONFIRMATION_REQUIRED",
        "Confirm delivery_unknown retry explicitly after checking Sent to prevent duplicate delivery.",
      );
    }
    if (
      current.status !== "failed"
      && current.status !== "auth_failed"
      && current.status !== "cancelled"
      && current.status !== "delivery_unknown"
    ) {
      throw new EasyEmailError(
        "SEND_QUEUE_RETRY_CONFLICT",
        `Cannot retry send queue item in status ${current.status}.`,
      );
    }
    const result = this.database.prepare(`
      UPDATE mail_send_queue
      SET status = 'queued',
          attempt_count = 0,
          next_retry_at = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error_code = NULL,
          last_error_message = NULL,
          version = version + 1,
          updated_at = ?
      WHERE id = ? AND version = ?
    `).run(now, id, current.version);
    if (Number(result.changes) === 0) {
      throw new EasyEmailError("SEND_QUEUE_VERSION_CONFLICT", "Send queue item was modified by another request.");
    }
    const updated = this.readRawById(id);
    return updated ? mapMailSendQueueRow(updated) : undefined;
  }

  public async reopenScheduledSendByMessageId(
    messageId: string,
    now: string,
  ): Promise<MailScheduledSendReopenResult> {
    return reopenScheduledSendInDatabase(this.database, messageId, now);
  }
}
