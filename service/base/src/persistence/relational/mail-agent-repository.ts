import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { EasyEmailError } from "../../domain/errors.js";
import type {
  MailAgentIncomingReplyAssociationResult,
  MailAgentRepository,
  MailAgentRepositoryCreateServiceInput,
  MailAgentRepositoryIncomingReplyInput,
  MailAgentRepositoryTaskEnqueueInput,
  MailAgentServiceRecord,
  MailAgentTaskSendResult,
  MailAgentThread,
  MailAgentThreadDetail,
  MailAgentThreadListQuery,
} from "../../domain/mail-agent.js";
import {
  associateIncomingAgentReplyInDatabase,
  mapAgentMessageRow,
  mapAgentServiceRow,
  mapAgentThreadRow,
  readAgentMessageRowById,
  readAgentThreadRowById,
  type RawAgentMessageRow,
  type RawAgentServiceRow,
  type RawAgentThreadRow,
} from "./mail-agent-reply-persistence.js";
import {
  SEND_QUEUE_SELECT_COLUMNS,
  mapMailSendQueueRow,
  type RawMailSendQueueRow,
} from "./mail-send-queue-row-mapper.js";

export class SqliteMailAgentRepository implements MailAgentRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public async createAgentService(
    input: MailAgentRepositoryCreateServiceInput,
  ): Promise<MailAgentServiceRecord> {
    this.database.prepare(`
      INSERT INTO mail_agent_services (
        id, display_name, email_address, description, service_kind, trust_level,
        default_sender_account_id, status, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)
    `).run(
      input.id,
      input.displayName,
      input.emailAddress,
      input.description ?? null,
      input.serviceKind,
      input.trustLevel,
      input.defaultSenderAccountId ?? null,
      input.now,
      input.now,
    );
    const created = await this.getAgentService(input.id);
    if (!created) {
      throw new Error("Agent service insert did not return a row.");
    }
    return created;
  }

  public async getAgentService(id: string): Promise<MailAgentServiceRecord | undefined> {
    const row = this.database.prepare(`
      SELECT id, display_name, email_address, description, service_kind, trust_level,
             default_sender_account_id, status, created_at, updated_at
      FROM mail_agent_services
      WHERE id = ? AND deleted_at IS NULL
    `).get(id) as unknown as RawAgentServiceRow | undefined;
    return row ? mapAgentServiceRow(row) : undefined;
  }

  public async getAgentServiceByEmail(
    emailAddress: string,
  ): Promise<MailAgentServiceRecord | undefined> {
    const row = this.database.prepare(`
      SELECT id, display_name, email_address, description, service_kind, trust_level,
             default_sender_account_id, status, created_at, updated_at
      FROM mail_agent_services
      WHERE lower(email_address) = lower(?) AND deleted_at IS NULL
      LIMIT 1
    `).get(emailAddress.trim().toLowerCase()) as unknown as RawAgentServiceRow | undefined;
    return row ? mapAgentServiceRow(row) : undefined;
  }

  public async listAgentServices(): Promise<MailAgentServiceRecord[]> {
    const rows = this.database.prepare(`
      SELECT id, display_name, email_address, description, service_kind, trust_level,
             default_sender_account_id, status, created_at, updated_at
      FROM mail_agent_services
      WHERE deleted_at IS NULL
      ORDER BY created_at ASC, id ASC
    `).all() as unknown as RawAgentServiceRow[];
    return rows.map(mapAgentServiceRow);
  }

  public async enqueueAgentTask(
    input: MailAgentRepositoryTaskEnqueueInput,
  ): Promise<MailAgentTaskSendResult> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (input.idempotencyKey) {
        const existingThread = this.database.prepare(`
          SELECT id, agent_service_id, sender_account_id, subject, status,
                 last_outgoing_message_id, last_incoming_message_id, correlation_key,
                 idempotency_key, payload_fingerprint, created_at, updated_at, completed_at
          FROM mail_agent_threads
          WHERE sender_account_id = ? AND idempotency_key = ?
          LIMIT 1
        `).get(input.senderAccountId, input.idempotencyKey) as unknown as RawAgentThreadRow | undefined;

        if (existingThread) {
          if (existingThread.payload_fingerprint !== input.payloadFingerprint) {
            throw new EasyEmailError(
              "AGENT_TASK_IDEMPOTENCY_CONFLICT",
              "Idempotency-Key was already used with a different Agent task payload.",
            );
          }
          const existingAgentMsg = this.database.prepare(`
            SELECT id, thread_id, message_id, direction, semantic_role, parsed_status, created_at
            FROM mail_agent_messages
            WHERE thread_id = ? AND direction = 'outgoing'
            ORDER BY created_at ASC, id ASC
            LIMIT 1
          `).get(existingThread.id) as unknown as RawAgentMessageRow | undefined;
          const existingQueue = existingThread.last_outgoing_message_id
            ? (this.database.prepare(`
                SELECT ${SEND_QUEUE_SELECT_COLUMNS}
                FROM mail_send_queue q
                LEFT JOIN mail_messages m ON m.id = q.message_id
                WHERE q.message_id = ?
                ORDER BY q.created_at DESC, q.id DESC
                LIMIT 1
              `).get(existingThread.last_outgoing_message_id) as unknown as RawMailSendQueueRow | undefined)
            : undefined;
          if (!existingAgentMsg || !existingQueue) {
            throw new Error("Deduplicated Agent task records are incomplete.");
          }
          this.database.exec("COMMIT");
          return {
            thread: mapAgentThreadRow(existingThread),
            agentMessage: mapAgentMessageRow(existingAgentMsg),
            queueItem: mapMailSendQueueRow(existingQueue),
            deduplicated: true,
          };
        }
      }

      const messageId = `msg_v1_${randomUUID()}`;
      const queueId = `send_v1_${randomUUID()}`;
      const threadId = `agthread_v1_${randomUUID()}`;
      const agentMessageId = `agmsg_v1_${randomUUID()}`;
      const correlationKey = `agent-${randomUUID()}`;
      const sourceId = `smtp:${input.senderAccountId}`;
      const senderDomain =
        input.senderAddress.slice(input.senderAddress.lastIndexOf("@") + 1).trim().toLowerCase()
        || "easyemail.local";
      const rfcMessageId = `<${randomUUID()}@${senderDomain}>`;

      this.database.prepare(`
        INSERT INTO mail_messages (
          id, rfc_message_id, thread_key, subject, from_address, from_name,
          snippet, body_text, body_html, body_cache_state, has_attachments,
          classification, observed_at, version, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'cached', 0, 'agent', ?, 1, ?, ?, NULL)
      `).run(
        messageId,
        rfcMessageId,
        correlationKey,
        input.subject,
        input.senderAddress,
        input.senderName,
        input.snippet,
        input.bodyText,
        input.now,
        input.now,
        input.now,
      );

      this.database.prepare(`
        INSERT INTO mail_message_sources (
          id, message_id, source_kind, source_ref_id, account_id, session_id,
          provider_instance_id, external_message_id, received_address, provider_label,
          lifecycle_state, is_read, is_starred, is_archived, is_important,
          local_folder, labels_json, draft_cc_json, draft_bcc_json, first_seen_at, last_seen_at
        ) VALUES (?, ?, 'smtp', ?, ?, NULL, NULL, NULL, ?, ?, 'ready', 1, 0, 0, 0, 'sent', '[]', '[]', '[]', ?, ?)
      `).run(
        `msrc_v1_${randomUUID()}`,
        messageId,
        sourceId,
        input.senderAccountId,
        input.targetAddress,
        input.providerLabel,
        input.now,
        input.now,
      );

      this.database.prepare(`
        INSERT INTO mail_agent_threads (
          id, agent_service_id, sender_account_id, subject, status,
          last_outgoing_message_id, last_incoming_message_id, correlation_key,
          idempotency_key, payload_fingerprint, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, 'awaiting_reply', ?, NULL, ?, ?, ?, ?, ?, NULL)
      `).run(
        threadId,
        input.agentServiceId,
        input.senderAccountId,
        input.subject,
        messageId,
        correlationKey,
        input.idempotencyKey ?? null,
        input.payloadFingerprint,
        input.now,
        input.now,
      );

      this.database.prepare(`
        INSERT INTO mail_agent_messages (
          id, thread_id, message_id, direction, semantic_role,
          parsed_status, parsed_payload_json, created_at
        ) VALUES (?, ?, ?, 'outgoing', 'task_request', 'queued', '{}', ?)
      `).run(agentMessageId, threadId, messageId, input.now);

      this.database.prepare(`
        INSERT INTO mail_send_queue (
          id, account_id, account_scope, source_id, message_id, sender_address,
          smtp_host, smtp_port, smtp_security, smtp_username, credential_ref_id,
          target_address, cc_addresses_json, bcc_addresses_json, idempotency_key,
          payload_fingerprint, status, attempt_count, scheduled_at, next_retry_at,
          lease_owner, lease_expires_at, provider_message_id, last_error_code,
          last_error_message, version, created_at, updated_at, sent_at
        ) VALUES (?, ?, 'agent', ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?, ?, 'queued', 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1, ?, ?, NULL)
      `).run(
        queueId,
        input.senderAccountId,
        sourceId,
        messageId,
        input.senderAddress,
        input.smtpHost,
        input.smtpPort,
        input.smtpSecurity,
        input.smtpUsername,
        input.credentialRefId,
        input.targetAddress,
        input.idempotencyKey ?? null,
        input.payloadFingerprint,
        input.now,
        input.now,
      );

      const createdThread = readAgentThreadRowById(this.database, threadId);
      const createdAgentMsg = readAgentMessageRowById(this.database, agentMessageId);
      const createdQueue = this.database.prepare(`
        SELECT ${SEND_QUEUE_SELECT_COLUMNS}
        FROM mail_send_queue q
        LEFT JOIN mail_messages m ON m.id = q.message_id
        WHERE q.id = ?
      `).get(queueId) as unknown as RawMailSendQueueRow | undefined;

      if (!createdThread || !createdAgentMsg || !createdQueue) {
        throw new Error("Agent task enqueue did not return created rows.");
      }

      this.database.exec("COMMIT");
      return {
        thread: mapAgentThreadRow(createdThread),
        agentMessage: mapAgentMessageRow(createdAgentMsg),
        queueItem: mapMailSendQueueRow(createdQueue),
        deduplicated: false,
      };
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Ignore rollback failure.
      }
      throw error;
    }
  }

  public async listAgentThreads(query: MailAgentThreadListQuery = {}): Promise<MailAgentThread[]> {
    const conditions: string[] = ["1 = 1"];
    const params: SQLInputValue[] = [];
    if (query.status) {
      conditions.push("status = ?");
      params.push(query.status);
    }
    if (query.senderAccountId) {
      conditions.push("sender_account_id = ?");
      params.push(query.senderAccountId);
    }
    if (query.agentServiceId) {
      conditions.push("agent_service_id = ?");
      params.push(query.agentServiceId);
    }
    const limit = query.limit ?? 200;
    params.push(limit);

    const rows = this.database.prepare(`
      SELECT id, agent_service_id, sender_account_id, subject, status,
             last_outgoing_message_id, last_incoming_message_id, correlation_key,
             idempotency_key, payload_fingerprint, created_at, updated_at, completed_at
      FROM mail_agent_threads
      WHERE ${conditions.join(" AND ")}
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `).all(...params) as unknown as RawAgentThreadRow[];
    return rows.map(mapAgentThreadRow);
  }

  public async getAgentThreadDetail(threadId: string): Promise<MailAgentThreadDetail | undefined> {
    const threadRow = readAgentThreadRowById(this.database, threadId);
    if (!threadRow) {
      return undefined;
    }
    const messageRows = this.database.prepare(`
      SELECT id, thread_id, message_id, direction, semantic_role, parsed_status, created_at
      FROM mail_agent_messages
      WHERE thread_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(threadId) as unknown as RawAgentMessageRow[];
    return {
      thread: mapAgentThreadRow(threadRow),
      messages: messageRows.map(mapAgentMessageRow),
    };
  }

  public async associateIncomingAgentReply(
    input: MailAgentRepositoryIncomingReplyInput,
  ): Promise<MailAgentIncomingReplyAssociationResult> {
    return associateIncomingAgentReplyInDatabase(this.database, input);
  }
}
