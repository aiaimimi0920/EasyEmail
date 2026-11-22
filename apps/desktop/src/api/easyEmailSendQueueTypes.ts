import type { EasyEmailMailAccountSmtpSecurity } from "./easyEmailMailTypes.ts";
import type { EasyEmailMailMessageDetail } from "./easyEmailMessageTypes.ts";

export type EasyEmailMailSendQueueScope = "normal" | "agent";
export type EasyEmailMailSendQueueSecurity = EasyEmailMailAccountSmtpSecurity;

export type EasyEmailMailSendQueueStatus =
  | "queued"
  | "sending"
  | "sent"
  | "auth_failed"
  | "delivery_unknown"
  | "cancelled"
  | "failed";

export type EasyEmailMailSendQueueItem = {
  id: string;
  accountId: string;
  accountScope: EasyEmailMailSendQueueScope;
  sourceId: string;
  messageId: string;
  senderAddress: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: EasyEmailMailSendQueueSecurity;
  smtpUsername: string;
  credentialRefId: string;
  targetAddress: string;
  ccAddresses: string[];
  bccAddresses: string[];
  subject: string;
  status: EasyEmailMailSendQueueStatus;
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
};

export type EasyEmailMailSendEnqueueRequest = {
  accountId: string;
  targetAddress: string;
  ccAddresses?: string[];
  bccAddresses?: string[];
  scheduledAt?: string | null;
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
  idempotencyKey?: string | null;
};

export type EasyEmailMailSendEnqueueResponse = {
  messageId: string;
  queueItem: EasyEmailMailSendQueueItem;
  deduplicated: boolean;
};

export type EasyEmailMailSendQueueWorkerRunResult = {
  processedCount: number;
  sentCount: number;
  retryCount: number;
  failedCount: number;
};

export type EasyEmailMailSendQueueWorkerStatus = {
  enabled: boolean;
  running: boolean;
  intervalMs: number;
  leaseDurationMs: number;
  lastRunAt?: string;
  lastResult?: EasyEmailMailSendQueueWorkerRunResult;
  totalProcessedCount: number;
  totalSentCount: number;
  totalRetryCount: number;
  totalFailedCount: number;
  lastErrorMessage?: string;
};

export type EasyEmailMailSendQueueListQuery = {
  accountId?: string;
  status?: EasyEmailMailSendQueueStatus;
  limit?: number;
  cursor?: string;
};

export type EasyEmailMailSendQueueListResponse = {
  items: EasyEmailMailSendQueueItem[];
  nextCursor?: string;
  worker: EasyEmailMailSendQueueWorkerStatus;
};

export type EasyEmailMailSendQueueItemResponse = {
  queueItem: EasyEmailMailSendQueueItem;
};

export type EasyEmailMailSendQueueRunItemResponse = {
  queueItem: EasyEmailMailSendQueueItem;
  runResult: EasyEmailMailSendQueueWorkerRunResult;
};

export type EasyEmailMailSendQueueRunWorkerResponse = {
  runResult: EasyEmailMailSendQueueWorkerRunResult;
};

export type EasyEmailMailSendQueueRunBatchRequest = {
  limit?: number | null;
};

export type EasyEmailMailSendQueueCancelRequest = {
  expectedVersion?: number;
};

export type EasyEmailMailSendQueueCancelResponse = {
  queueItem: EasyEmailMailSendQueueItem;
};

export type EasyEmailMailSendQueueRetryRequest = {
  expectedVersion?: number;
  confirmDeliveryUnknown?: boolean;
};

export type EasyEmailMailSendQueueRetryResponse = {
  queueItem: EasyEmailMailSendQueueItem;
};

export type EasyEmailMailScheduledSendReopenResponse = {
  message: EasyEmailMailMessageDetail;
  queueItem: EasyEmailMailSendQueueItem;
};
