import type {
  MailSendQueueClaimedPayload,
  MailSendQueueItem,
  MailSendQueueScope,
  MailSendQueueSecurity,
  MailSendQueueStatus,
} from "../../domain/mail-send-queue.js";
import { parseStringArrayJson } from "./mail-message-row-mapper.js";

export interface RawMailSendQueueRow {
  id: string;
  account_id: string;
  account_scope: MailSendQueueScope;
  source_id: string;
  message_id: string;
  sender_address: string;
  smtp_host: string;
  smtp_port: number;
  smtp_security: MailSendQueueSecurity;
  smtp_username: string;
  credential_ref_id: string;
  target_address: string;
  cc_addresses_json: string;
  bcc_addresses_json: string;
  idempotency_key: string | null;
  payload_fingerprint: string;
  subject: string;
  body_text: string | null;
  body_html: string | null;
  status: MailSendQueueStatus;
  attempt_count: number;
  scheduled_at: string | null;
  next_retry_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  provider_message_id: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
}

export const SEND_QUEUE_SELECT_COLUMNS = `
  q.id,
  q.account_id,
  q.account_scope,
  q.source_id,
  q.message_id,
  q.sender_address,
  q.smtp_host,
  q.smtp_port,
  q.smtp_security,
  q.smtp_username,
  q.credential_ref_id,
  q.target_address,
  q.cc_addresses_json,
  q.bcc_addresses_json,
  q.idempotency_key,
  q.payload_fingerprint,
  COALESCE(m.subject, '') AS subject,
  m.body_text AS body_text,
  m.body_html AS body_html,
  q.status,
  q.attempt_count,
  q.scheduled_at,
  q.next_retry_at,
  q.lease_owner,
  q.lease_expires_at,
  q.provider_message_id,
  q.last_error_code,
  q.last_error_message,
  q.version,
  q.created_at,
  q.updated_at,
  q.sent_at
`;

export function mapMailSendQueueRow(row: RawMailSendQueueRow): MailSendQueueItem {
  return {
    id: row.id,
    accountId: row.account_id,
    accountScope: row.account_scope,
    sourceId: row.source_id,
    messageId: row.message_id,
    senderAddress: row.sender_address,
    smtpHost: row.smtp_host,
    smtpPort: row.smtp_port,
    smtpSecurity: row.smtp_security,
    smtpUsername: row.smtp_username,
    credentialRefId: row.credential_ref_id,
    targetAddress: row.target_address,
    ccAddresses: parseStringArrayJson(row.cc_addresses_json),
    bccAddresses: parseStringArrayJson(row.bcc_addresses_json),
    subject: row.subject,
    status: row.status,
    attemptCount: row.attempt_count,
    ...(row.scheduled_at ? { scheduledAt: row.scheduled_at } : {}),
    ...(row.next_retry_at ? { nextRetryAt: row.next_retry_at } : {}),
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
    ...(row.provider_message_id ? { providerMessageId: row.provider_message_id } : {}),
    ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
    ...(row.last_error_message ? { lastErrorMessage: row.last_error_message } : {}),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.sent_at ? { sentAt: row.sent_at } : {}),
  };
}

export function mapClaimedSendPayload(row: RawMailSendQueueRow): MailSendQueueClaimedPayload {
  return {
    queueItem: mapMailSendQueueRow(row),
    bodyText: row.body_text ?? "",
    ...(row.body_html ? { bodyHtml: row.body_html } : {}),
  };
}
