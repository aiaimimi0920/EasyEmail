import type { MailAccountSmtpSecurity } from "./contracts-catalog.js";
import type { MailMessageDetail } from "./contracts-messages.js";

export type MailSendQueueScope = "normal" | "agent";

export type MailSendQueueStatus =
  | "queued"
  | "sending"
  | "sent"
  | "auth_failed"
  | "delivery_unknown"
  | "cancelled"
  | "failed";

export interface MailSendQueueItem {
  id: string;
  accountId: string;
  accountScope: MailSendQueueScope;
  sourceId: string;
  messageId: string;
  senderAddress: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: MailAccountSmtpSecurity;
  smtpUsername: string;
  credentialRefId: string;
  targetAddress: string;
  ccAddresses: string[];
  bccAddresses: string[];
  subject: string;
  status: MailSendQueueStatus;
  attemptCount: number;
  scheduledAt?: string;
  nextRetryAt?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  providerMessageId?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
}

export interface MailSendEnqueueInput {
  accountId: string;
  targetAddress: string;
  ccAddresses?: string[];
  bccAddresses?: string[];
  scheduledAt?: string | null;
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
  idempotencyKey?: string | null;
}

export interface MailSendEnqueueResult {
  messageId: string;
  queueItem: MailSendQueueItem;
  deduplicated: boolean;
}

export interface MailSendQueueWorkerRunResult {
  processedCount: number;
  sentCount: number;
  retryCount: number;
  failedCount: number;
}

export interface MailSendQueueWorkerStatus {
  enabled: boolean;
  running: boolean;
  intervalMs: number;
  leaseDurationMs: number;
  lastRunAt?: string;
  lastResult?: MailSendQueueWorkerRunResult;
  totalProcessedCount: number;
  totalSentCount: number;
  totalRetryCount: number;
  totalFailedCount: number;
  lastErrorMessage?: string;
}

export interface MailSendQueueListQuery {
  accountId?: string;
  status?: MailSendQueueStatus;
  limit?: number;
  cursor?: string;
}

export interface MailSendQueueListResult {
  items: MailSendQueueItem[];
  nextCursor?: string;
  worker: MailSendQueueWorkerStatus;
}

export interface MailSendQueueRunBatchInput {
  limit?: number | null;
}

export interface MailSendQueueCancelInput {
  expectedVersion?: number;
}

export interface MailSendQueueRetryInput {
  expectedVersion?: number;
  confirmDeliveryUnknown?: boolean;
}

export interface MailSendQueueRunItemResult {
  queueItem: MailSendQueueItem;
  runResult: MailSendQueueWorkerRunResult;
}

export interface MailScheduledSendReopenResult {
  message: MailMessageDetail;
  queueItem: MailSendQueueItem;
}
