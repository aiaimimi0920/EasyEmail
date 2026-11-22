import type { MailAccountSmtpSecurity } from "./account.js";
import type { MailMessageDetail } from "./mail-message.js";

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
  smtpSecurity: MailSendQueueSecurity;
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

export type MailSendQueueSecurity = MailAccountSmtpSecurity;

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

export interface MailScheduledSendReopenResult {
  message: MailMessageDetail;
  queueItem: MailSendQueueItem;
}

export interface MailSendQueueListPosition {
  filterAccountId: string;
  filterStatus: MailSendQueueStatus | "all";
  createdAt: string;
  id: string;
}

export interface MailSendQueueRepositoryListQuery {
  accountId?: string;
  status?: MailSendQueueStatus;
  limit: number;
  after?: MailSendQueueListPosition;
}

export interface MailSendQueueRepositoryListResult {
  items: MailSendQueueItem[];
  hasMore: boolean;
}

export interface MailSendQueueRepositoryEnqueueInput {
  accountId: string;
  accountScope: MailSendQueueScope;
  providerLabel: string;
  senderAddress: string;
  senderName?: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: MailSendQueueSecurity;
  smtpUsername: string;
  credentialRefId: string;
  targetAddress: string;
  ccAddresses: string[];
  bccAddresses: string[];
  scheduledAt?: string;
  subject: string;
  snippet: string;
  bodyText: string;
  bodyHtml?: string;
  idempotencyKey?: string;
  payloadFingerprint: string;
  now: string;
}

export interface MailSendQueueClaimedPayload {
  queueItem: MailSendQueueItem;
  bodyText: string;
  bodyHtml?: string;
}

export interface MailSendQueueRepository {
  enqueueOutgoingSend(input: MailSendQueueRepositoryEnqueueInput): Promise<MailSendEnqueueResult>;
  listSendQueue(query: MailSendQueueRepositoryListQuery): Promise<MailSendQueueRepositoryListResult>;
  getSendQueueItem(id: string): Promise<MailSendQueueItem | undefined>;
  recoverStaleLeases(now: string): Promise<number>;
  claimNextDueSend(leaseOwner: string, leaseExpiresAt: string, now: string): Promise<MailSendQueueClaimedPayload | undefined>;
  claimNextDueScheduledSend(leaseOwner: string, leaseExpiresAt: string, now: string): Promise<MailSendQueueClaimedPayload | undefined>;
  claimDueSendById(id: string, leaseOwner: string, leaseExpiresAt: string, now: string): Promise<MailSendQueueClaimedPayload | undefined>;
  completeClaimedSendSent(id: string, leaseOwner: string, providerMessageId: string | undefined, now: string): Promise<MailSendQueueItem | undefined>;
  completeClaimedSendRetry(id: string, leaseOwner: string, nextRetryAt: string, errorCode: string, errorMessage: string, now: string): Promise<MailSendQueueItem | undefined>;
  completeClaimedSendFailed(id: string, leaseOwner: string, terminalStatus: "failed" | "auth_failed", errorCode: string, errorMessage: string, now: string): Promise<MailSendQueueItem | undefined>;
  cancelQueuedSend(id: string, expectedVersion: number | undefined, now: string): Promise<MailSendQueueItem | undefined>;
  retryTerminalSend(id: string, expectedVersion: number | undefined, allowDeliveryUnknown: boolean, now: string): Promise<MailSendQueueItem | undefined>;
  reopenScheduledSendByMessageId(messageId: string, now: string): Promise<MailScheduledSendReopenResult>;
}
