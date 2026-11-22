import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  MailAgentIncomingReplyAssociationResult,
  MailAgentMessage,
  MailAgentMessageDirection,
  MailAgentRepositoryIncomingReplyInput,
  MailAgentServiceRecord,
  MailAgentServiceStatus,
  MailAgentThread,
  MailAgentThreadStatus,
  MailAgentTrustLevel,
} from "../../domain/mail-agent.js";

export interface RawAgentServiceRow {
  id: string;
  display_name: string;
  email_address: string;
  description: string | null;
  service_kind: string;
  trust_level: MailAgentTrustLevel;
  default_sender_account_id: string | null;
  status: MailAgentServiceStatus;
  created_at: string;
  updated_at: string;
}

export interface RawAgentThreadRow {
  id: string;
  agent_service_id: string;
  sender_account_id: string;
  subject: string;
  status: MailAgentThreadStatus;
  last_outgoing_message_id: string | null;
  last_incoming_message_id: string | null;
  correlation_key: string;
  idempotency_key: string | null;
  payload_fingerprint: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface RawAgentMessageRow {
  id: string;
  thread_id: string;
  message_id: string;
  direction: MailAgentMessageDirection;
  semantic_role: string;
  parsed_status: string | null;
  created_at: string;
}

export function mapAgentServiceRow(row: RawAgentServiceRow): MailAgentServiceRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    emailAddress: row.email_address,
    ...(row.description ? { description: row.description } : {}),
    serviceKind: row.service_kind,
    trustLevel: row.trust_level,
    ...(row.default_sender_account_id
      ? { defaultSenderAccountId: row.default_sender_account_id }
      : {}),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapAgentThreadRow(row: RawAgentThreadRow): MailAgentThread {
  return {
    id: row.id,
    agentServiceId: row.agent_service_id,
    senderAccountId: row.sender_account_id,
    subject: row.subject,
    status: row.status,
    ...(row.last_outgoing_message_id
      ? { lastOutgoingMessageId: row.last_outgoing_message_id }
      : {}),
    ...(row.last_incoming_message_id
      ? { lastIncomingMessageId: row.last_incoming_message_id }
      : {}),
    correlationKey: row.correlation_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

export function mapAgentMessageRow(row: RawAgentMessageRow): MailAgentMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    messageId: row.message_id,
    direction: row.direction,
    semanticRole: row.semantic_role,
    ...(row.parsed_status ? { parsedStatus: row.parsed_status } : {}),
    createdAt: row.created_at,
  };
}

export function readAgentThreadRowById(
  database: DatabaseSync,
  id: string,
): RawAgentThreadRow | undefined {
  return database.prepare(`
    SELECT id, agent_service_id, sender_account_id, subject, status,
           last_outgoing_message_id, last_incoming_message_id, correlation_key,
           idempotency_key, payload_fingerprint, created_at, updated_at, completed_at
    FROM mail_agent_threads
    WHERE id = ?
  `).get(id) as unknown as RawAgentThreadRow | undefined;
}

export function readAgentMessageRowById(
  database: DatabaseSync,
  id: string,
): RawAgentMessageRow | undefined {
  return database.prepare(`
    SELECT id, thread_id, message_id, direction, semantic_role, parsed_status, created_at
    FROM mail_agent_messages
    WHERE id = ?
  `).get(id) as unknown as RawAgentMessageRow | undefined;
}

export function associateIncomingAgentReplyInDatabase(
  database: DatabaseSync,
  input: MailAgentRepositoryIncomingReplyInput,
): MailAgentIncomingReplyAssociationResult {
  database.exec("BEGIN IMMEDIATE");
  try {
    const existingMsg = database.prepare(`
      SELECT id, thread_id, message_id, direction, semantic_role, parsed_status, created_at
      FROM mail_agent_messages
      WHERE message_id = ? AND direction = 'incoming'
      LIMIT 1
    `).get(input.messageId) as unknown as RawAgentMessageRow | undefined;

    if (existingMsg) {
      const existingThread = readAgentThreadRowById(database, existingMsg.thread_id);
      if (!existingThread) {
        throw new Error("Existing Agent reply message references a missing thread.");
      }
      database.exec("COMMIT");
      return {
        status: existingMsg.parsed_status === "linked" ? "linked" : "needs_attention",
        thread: mapAgentThreadRow(existingThread),
        agentMessage: mapAgentMessageRow(existingMsg),
        deduplicated: true,
      };
    }

    let matchedThread: RawAgentThreadRow | undefined;
    for (const candidateRfcId of input.candidateRfcIds) {
      const trimmed = candidateRfcId.trim();
      if (!trimmed) continue;
      matchedThread = database.prepare(`
        SELECT t.id, t.agent_service_id, t.sender_account_id, t.subject, t.status,
               t.last_outgoing_message_id, t.last_incoming_message_id, t.correlation_key,
               t.idempotency_key, t.payload_fingerprint, t.created_at, t.updated_at, t.completed_at
        FROM mail_agent_threads t
        INNER JOIN mail_agent_messages am ON am.thread_id = t.id
        INNER JOIN mail_messages m ON m.id = am.message_id
        WHERE am.direction = 'outgoing'
          AND t.agent_service_id = ?
          AND t.sender_account_id = ?
          AND m.rfc_message_id IS NOT NULL
          AND lower(m.rfc_message_id) = lower(?)
        ORDER BY am.created_at DESC, t.updated_at DESC
        LIMIT 1
      `).get(
        input.agentServiceId,
        input.fallbackSenderAccountId,
        trimmed,
      ) as unknown as RawAgentThreadRow | undefined;
      if (matchedThread) {
        break;
      }
    }

    const agentMessageId = `agmsg_v1_${randomUUID()}`;
    if (matchedThread) {
      database.prepare(`
        INSERT INTO mail_agent_messages (
          id, thread_id, message_id, direction, semantic_role,
          parsed_status, parsed_payload_json, created_at
        ) VALUES (?, ?, ?, 'incoming', 'agent_reply', 'linked', '{}', ?)
      `).run(agentMessageId, matchedThread.id, input.messageId, input.now);

      database.prepare(`
        UPDATE mail_agent_threads
        SET status = 'in_progress',
            last_incoming_message_id = ?,
            updated_at = ?
        WHERE id = ?
      `).run(input.messageId, input.now, matchedThread.id);

      const updatedThread = readAgentThreadRowById(database, matchedThread.id)!;
      const createdMsg = readAgentMessageRowById(database, agentMessageId)!;
      database.exec("COMMIT");
      return {
        status: "linked",
        thread: mapAgentThreadRow(updatedThread),
        agentMessage: mapAgentMessageRow(createdMsg),
        deduplicated: false,
      };
    }

    const newThreadId = `agthread_v1_${randomUUID()}`;
    const correlationKey = `agent-unmatched-${randomUUID()}`;
    database.prepare(`
      INSERT INTO mail_agent_threads (
        id, agent_service_id, sender_account_id, subject, status,
        last_outgoing_message_id, last_incoming_message_id, correlation_key,
        idempotency_key, payload_fingerprint, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, 'needs_attention', NULL, ?, ?, NULL, NULL, ?, ?, NULL)
    `).run(
      newThreadId,
      input.agentServiceId,
      input.fallbackSenderAccountId,
      input.subject || "(no subject)",
      input.messageId,
      correlationKey,
      input.now,
      input.now,
    );

    database.prepare(`
      INSERT INTO mail_agent_messages (
        id, thread_id, message_id, direction, semantic_role,
        parsed_status, parsed_payload_json, created_at
      ) VALUES (?, ?, ?, 'incoming', 'agent_reply', 'needs_attention', '{}', ?)
    `).run(agentMessageId, newThreadId, input.messageId, input.now);

    const createdThread = readAgentThreadRowById(database, newThreadId)!;
    const createdMsg = readAgentMessageRowById(database, agentMessageId)!;
    database.exec("COMMIT");
    return {
      status: "needs_attention",
      thread: mapAgentThreadRow(createdThread),
      agentMessage: mapAgentMessageRow(createdMsg),
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
