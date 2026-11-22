import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { EasyEmailError } from "../../domain/errors.js";
import type { MailSendQueueStatus } from "../../domain/mail-send-queue.js";
import type { MappedLegacyAccount } from "./legacy-account-mapper.js";

export interface MappedLegacySendQueueItem {
  id: string;
  accountId: string;
  accountScope: "normal" | "agent";
  sourceId: string;
  messageId: string;
  senderAddress: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: "tls" | "starttls";
  smtpUsername: string;
  preferredCredentialRefId: string | null;
  targetAddress: string;
  ccAddressesJson: string;
  bccAddressesJson: string;
  payloadFingerprint: string;
  status: MailSendQueueStatus;
  attemptCount: number;
  scheduledAt: string | null;
  nextRetryAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
}

export interface MappedLegacyAgentService {
  id: string;
  displayName: string;
  emailAddress: string;
  description: string | null;
  serviceKind: string;
  trustLevel: "unknown" | "trusted" | "restricted" | "blocked";
  defaultSenderAccountId: string | null;
  status: "active" | "disabled" | "archived";
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface MappedLegacyAgentThread {
  id: string;
  agentServiceId: string;
  senderAccountId: string;
  subject: string;
  status: string;
  lastOutgoingMessageId: string | null;
  lastIncomingMessageId: string | null;
  correlationKey: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface MappedLegacyAgentMessage {
  id: string;
  threadId: string;
  messageId: string;
  direction: "outgoing" | "incoming";
  semanticRole: string;
  parsedStatus: string | null;
  parsedPayloadJson: string;
  createdAt: string;
}

function assertIso(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed || Number.isNaN(Date.parse(trimmed))) {
    throw new EasyEmailError("LEGACY_IMPORT_INVALID_RECORD", `Legacy ${field} timestamp is invalid.`);
  }
  return new Date(Date.parse(trimmed)).toISOString();
}

function parseStringArrayJson(value: unknown): string[] {
  if (typeof value === "string") {
    try {
      return parseStringArrayJson(JSON.parse(value));
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function hasColumn(sourceDb: DatabaseSync, tableName: string, columnName: string): boolean {
  const rows = sourceDb.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

export function readAndMapLegacyDeliveryAndAgentDomains(
  sourceDb: DatabaseSync,
  existingTables: ReadonlySet<string>,
  accountsById: ReadonlyMap<string, MappedLegacyAccount>,
  messageIds: ReadonlySet<string>,
): {
  sendQueueItems: MappedLegacySendQueueItem[];
  agentServices: MappedLegacyAgentService[];
  agentThreads: MappedLegacyAgentThread[];
  agentMessages: MappedLegacyAgentMessage[];
} {
  const sendQueueItems: MappedLegacySendQueueItem[] = [];
  if (existingTables.has("send_queue")) {
    const withCcBcc = hasColumn(sourceDb, "send_queue", "cc_addresses_json");
    const rows = sourceDb.prepare(`
      SELECT id, account_id, source_id, message_id, target_address,
             ${withCcBcc ? "cc_addresses_json, bcc_addresses_json," : "'[]' AS cc_addresses_json, '[]' AS bcc_addresses_json,"}
             status, attempt_count, next_retry_at, last_error_code, last_error_message,
             created_at, updated_at, sent_at
      FROM send_queue ORDER BY created_at ASC, id ASC
    `).all() as Array<{
      id: string; account_id: string; source_id: string; message_id: string; target_address: string;
      cc_addresses_json: string; bcc_addresses_json: string; status: string; attempt_count: number;
      next_retry_at: string | null; last_error_code: string | null; last_error_message: string | null;
      created_at: string; updated_at: string; sent_at: string | null;
    }>;

    for (const row of rows) {
      const account = accountsById.get(row.account_id);
      if (!account || !messageIds.has(row.message_id)) continue;
      const smtpCred = account.credentialRefs.find((ref) => ref.credentialKind === "smtp_password")
        ?? account.credentialRefs[0];
      let status: MailSendQueueStatus;
      let lastErrorCode = row.last_error_code ?? null;
      let lastErrorMessage = row.last_error_message ?? null;
      if (row.status === "sending") {
        status = "delivery_unknown";
        lastErrorCode ??= "LEGACY_IN_FLIGHT_SEND_INTERRUPTED";
        lastErrorMessage ??= "Send was in progress when legacy EasyEmailAM stopped; verify before retrying.";
      } else if (
        row.status === "queued"
        && (!account.smtp || !smtpCred || smtpCred.status !== "active")
      ) {
        status = "auth_failed";
        lastErrorCode ??= "ACCOUNT_CREDENTIAL_MISSING";
        lastErrorMessage ??= "SMTP configuration or credential requires reauthorization after legacy import.";
      } else if (
        row.status === "queued"
        || row.status === "sent"
        || row.status === "failed"
        || row.status === "auth_failed"
      ) {
        status = row.status;
      } else {
        status = "failed";
      }

      const ccJson = JSON.stringify(parseStringArrayJson(row.cc_addresses_json));
      const bccJson = JSON.stringify(parseStringArrayJson(row.bcc_addresses_json));
      const nextRetryAt = row.next_retry_at ? assertIso(row.next_retry_at, "send_queue.next_retry_at") : null;
      sendQueueItems.push({
        id: row.id.trim(),
        accountId: account.id,
        accountScope: account.scope,
        sourceId: row.source_id.trim() || `smtp_${account.id}`,
        messageId: row.message_id.trim(),
        senderAddress: account.primaryAddress,
        smtpHost: account.smtp?.host ?? account.imap?.host ?? "smtp.legacy.invalid",
        smtpPort: account.smtp?.port ?? 465,
        smtpSecurity: account.smtp?.security ?? "tls",
        smtpUsername: account.smtp?.username ?? account.primaryAddress,
        preferredCredentialRefId: smtpCred?.id ?? null,
        targetAddress: row.target_address.trim(),
        ccAddressesJson: ccJson,
        bccAddressesJson: bccJson,
        payloadFingerprint: createHash("sha256")
          .update(`${account.id}|${row.message_id}|${row.target_address}|${ccJson}|${bccJson}`, "utf8")
          .digest("hex"),
        status,
        attemptCount: Math.max(0, row.attempt_count),
        scheduledAt: status === "queued" && row.attempt_count === 0 ? nextRetryAt : null,
        nextRetryAt,
        lastErrorCode,
        lastErrorMessage,
        createdAt: assertIso(row.created_at, "send_queue.created_at"),
        updatedAt: assertIso(row.updated_at, "send_queue.updated_at"),
        sentAt: row.sent_at ? assertIso(row.sent_at, "send_queue.sent_at") : null,
      });
    }
  }

  const agentServices: MappedLegacyAgentService[] = existingTables.has("agent_services")
    ? (sourceDb.prepare(`
        SELECT id, display_name, email_address, description, service_kind, trust_level,
               default_sender_account_id, status, created_at, updated_at, deleted_at
        FROM agent_services ORDER BY created_at ASC, id ASC
      `).all() as Array<{
        id: string; display_name: string; email_address: string; description: string | null;
        service_kind: string; trust_level: string; default_sender_account_id: string | null;
        status: string; created_at: string; updated_at: string; deleted_at: string | null;
      }>).map((row) => ({
        id: row.id.trim(),
        displayName: row.display_name.trim() || row.email_address.trim(),
        emailAddress: row.email_address.trim().toLowerCase(),
        description: row.description?.trim() || null,
        serviceKind: row.service_kind.trim() || "external_agent",
        trustLevel: (["unknown", "trusted", "restricted", "blocked"].includes(row.trust_level)
          ? row.trust_level
          : "unknown") as MappedLegacyAgentService["trustLevel"],
        defaultSenderAccountId: row.default_sender_account_id && accountsById.has(row.default_sender_account_id)
          ? row.default_sender_account_id
          : null,
        status: (["active", "disabled", "archived"].includes(row.status)
          ? row.status
          : "active") as MappedLegacyAgentService["status"],
        createdAt: assertIso(row.created_at, "agent_service.created_at"),
        updatedAt: assertIso(row.updated_at, "agent_service.updated_at"),
        deletedAt: row.deleted_at ? assertIso(row.deleted_at, "agent_service.deleted_at") : null,
      }))
    : [];

  const serviceIds = new Set(agentServices.map((svc) => svc.id));
  const agentThreads: MappedLegacyAgentThread[] = existingTables.has("agent_threads")
    ? (sourceDb.prepare(`
        SELECT id, agent_service_id, sender_account_id, subject, status,
               last_outgoing_message_id, last_incoming_message_id, correlation_key,
               created_at, updated_at, completed_at
        FROM agent_threads ORDER BY created_at ASC, id ASC
      `).all() as Array<{
        id: string; agent_service_id: string; sender_account_id: string; subject: string;
        status: string; last_outgoing_message_id: string | null; last_incoming_message_id: string | null;
        correlation_key: string; created_at: string; updated_at: string; completed_at: string | null;
      }>)
      .filter((row) => serviceIds.has(row.agent_service_id) && accountsById.has(row.sender_account_id))
      .map((row) => ({
        id: row.id.trim(),
        agentServiceId: row.agent_service_id,
        senderAccountId: row.sender_account_id,
        subject: row.subject,
        status: row.status,
        lastOutgoingMessageId: row.last_outgoing_message_id && messageIds.has(row.last_outgoing_message_id)
          ? row.last_outgoing_message_id
          : null,
        lastIncomingMessageId: row.last_incoming_message_id && messageIds.has(row.last_incoming_message_id)
          ? row.last_incoming_message_id
          : null,
        correlationKey: row.correlation_key.trim() || `corr_${row.id.trim()}`,
        createdAt: assertIso(row.created_at, "agent_thread.created_at"),
        updatedAt: assertIso(row.updated_at, "agent_thread.updated_at"),
        completedAt: row.completed_at ? assertIso(row.completed_at, "agent_thread.completed_at") : null,
      }))
    : [];

  const threadIds = new Set(agentThreads.map((thr) => thr.id));
  const agentMessages: MappedLegacyAgentMessage[] = existingTables.has("agent_messages")
    ? (sourceDb.prepare(`
        SELECT id, thread_id, message_id, direction, semantic_role,
               parsed_status, parsed_payload_json, created_at
        FROM agent_messages ORDER BY created_at ASC, id ASC
      `).all() as Array<{
        id: string; thread_id: string; message_id: string; direction: string;
        semantic_role: string; parsed_status: string | null; parsed_payload_json: string; created_at: string;
      }>)
      .filter((row) => threadIds.has(row.thread_id) && messageIds.has(row.message_id))
      .map((row) => ({
        id: row.id.trim(),
        threadId: row.thread_id,
        messageId: row.message_id,
        direction: row.direction === "incoming" ? "incoming" : "outgoing",
        semanticRole: row.semantic_role.trim() || "task_message",
        parsedStatus: row.parsed_status ?? null,
        parsedPayloadJson: row.parsed_payload_json || "{}",
        createdAt: assertIso(row.created_at, "agent_message.created_at"),
      }))
    : [];

  return { sendQueueItems, agentServices, agentThreads, agentMessages };
}
