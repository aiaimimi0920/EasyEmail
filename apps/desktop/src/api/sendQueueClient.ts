import type { MessageDetailDto } from "../app/appTypes.ts";
import type {
  EasyEmailMailScheduledSendReopenResponse,
  EasyEmailMailSendEnqueueRequest,
  EasyEmailMailSendEnqueueResponse,
  EasyEmailMailSendQueueCancelRequest,
  EasyEmailMailSendQueueCancelResponse,
  EasyEmailMailSendQueueItem,
  EasyEmailMailSendQueueItemResponse,
  EasyEmailMailSendQueueListQuery,
  EasyEmailMailSendQueueListResponse,
  EasyEmailMailSendQueueRetryRequest,
  EasyEmailMailSendQueueRetryResponse,
  EasyEmailMailSendQueueRunBatchRequest,
  EasyEmailMailSendQueueRunItemResponse,
  EasyEmailMailSendQueueRunWorkerResponse,
  EasyEmailMailSendQueueStatus,
  EasyEmailMailSendQueueWorkerRunResult,
  EasyEmailMailSendQueueWorkerStatus,
} from "./easyEmailHttpClient.ts";
import { toMessageDetailDto } from "./mailMessageClient.ts";

export type SendQueueDto = {
  id: string;
  account_id: string;
  source_id: string;
  message_id: string;
  target_address: string;
  cc_addresses: string[];
  bcc_addresses: string[];
  subject: string;
  status: string;
  attempt_count: number;
  scheduled_at: string | null;
  next_retry_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
};

export type SendQueueWorkerRunResult = {
  processed_count: number;
  sent_count: number;
  retry_count: number;
  failed_count: number;
};

export type SendQueueWorkerStatusDto = {
  enabled: boolean;
  running: boolean;
  interval_ms: number;
  lease_duration_ms: number;
  last_run_at: string | null;
  last_result: SendQueueWorkerRunResult | null;
  total_processed_count: number;
  total_sent_count: number;
  total_retry_count: number;
  total_failed_count: number;
  last_error_message: string | null;
};

export type SendEnqueueRequest = {
  account_id: string;
  target_address: string;
  cc_addresses?: string[];
  bcc_addresses?: string[];
  scheduled_at?: string | null;
  subject: string;
  body_text: string;
  body_html?: string | null;
  idempotency_key?: string | null;
};

export type SendEnqueueResultDto = {
  message_id: string;
  account_id: string;
  queue_id: string;
  status: string;
  deduplicated: boolean;
  queue_item: SendQueueDto;
};

export type SendQueueListRequest = {
  limit: number | null;
  account_id?: string | null;
  status?: EasyEmailMailSendQueueStatus | null;
};

export type SendQueueRunItemRequest = {
  queue_id: string;
};

export type SendQueueRunDueBatchRequest = {
  limit: number | null;
};

export type SendQueueCancelItemRequest = {
  queue_id: string;
  expected_version?: number;
};

export type SendQueueRetryItemRequest = {
  queue_id: string;
  expected_version?: number;
  confirm_delivery_unknown?: boolean;
};

export interface SendQueueHttpTransport {
  enqueueMailSend(
    request: EasyEmailMailSendEnqueueRequest,
    options?: { idempotencyKey?: string },
  ): Promise<EasyEmailMailSendEnqueueResponse>;
  listMailSendQueue(query?: EasyEmailMailSendQueueListQuery): Promise<EasyEmailMailSendQueueListResponse>;
  getMailSendQueueItem(queueItemId: string): Promise<EasyEmailMailSendQueueItemResponse>;
  runMailSendQueueItem(queueItemId: string): Promise<EasyEmailMailSendQueueRunItemResponse>;
  cancelMailSendQueueItem(
    queueItemId: string,
    request?: EasyEmailMailSendQueueCancelRequest,
  ): Promise<EasyEmailMailSendQueueCancelResponse>;
  retryMailSendQueueItem(
    queueItemId: string,
    request?: EasyEmailMailSendQueueRetryRequest,
  ): Promise<EasyEmailMailSendQueueRetryResponse>;
  runMailSendQueueOnce(): Promise<EasyEmailMailSendQueueRunWorkerResponse>;
  runMailSendQueueDueBatch(
    request?: EasyEmailMailSendQueueRunBatchRequest,
  ): Promise<EasyEmailMailSendQueueRunWorkerResponse>;
  reopenScheduledSend(messageId: string): Promise<EasyEmailMailScheduledSendReopenResponse>;
}

function toSendQueueDto(item: EasyEmailMailSendQueueItem): SendQueueDto {
  return {
    id: item.id,
    account_id: item.accountId,
    source_id: item.sourceId,
    message_id: item.messageId,
    target_address: item.targetAddress,
    cc_addresses: [...item.ccAddresses],
    bcc_addresses: [...item.bccAddresses],
    subject: item.subject,
    status: item.status,
    attempt_count: item.attemptCount,
    scheduled_at: item.scheduledAt ?? null,
    next_retry_at: item.nextRetryAt ?? null,
    last_error_code: item.lastErrorCode ?? null,
    last_error_message: item.lastErrorMessage ?? null,
    version: item.version,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    sent_at: item.sentAt ?? null,
  };
}

function toSendQueueWorkerRunResult(
  result: EasyEmailMailSendQueueWorkerRunResult,
): SendQueueWorkerRunResult {
  return {
    processed_count: result.processedCount,
    sent_count: result.sentCount,
    retry_count: result.retryCount,
    failed_count: result.failedCount,
  };
}

function toSendQueueWorkerStatusDto(
  worker: EasyEmailMailSendQueueWorkerStatus,
): SendQueueWorkerStatusDto {
  return {
    enabled: worker.enabled,
    running: worker.running,
    interval_ms: worker.intervalMs,
    lease_duration_ms: worker.leaseDurationMs,
    last_run_at: worker.lastRunAt ?? null,
    last_result: worker.lastResult ? toSendQueueWorkerRunResult(worker.lastResult) : null,
    total_processed_count: worker.totalProcessedCount,
    total_sent_count: worker.totalSentCount,
    total_retry_count: worker.totalRetryCount,
    total_failed_count: worker.totalFailedCount,
    last_error_message: worker.lastErrorMessage ?? null,
  };
}

export function createSendQueueClient(transport: SendQueueHttpTransport) {
  return {
    async enqueueSend(request: SendEnqueueRequest): Promise<SendEnqueueResultDto> {
      const idempotencyKey = request.idempotency_key?.trim() || undefined;
      const response = await transport.enqueueMailSend(
        {
          accountId: request.account_id,
          targetAddress: request.target_address,
          ccAddresses: request.cc_addresses,
          bccAddresses: request.bcc_addresses,
          scheduledAt: request.scheduled_at ?? null,
          subject: request.subject,
          bodyText: request.body_text,
          bodyHtml: request.body_html ?? null,
          idempotencyKey,
        },
        idempotencyKey ? { idempotencyKey } : undefined,
      );
      const queueDto = toSendQueueDto(response.queueItem);
      return {
        message_id: response.messageId,
        account_id: queueDto.account_id,
        queue_id: queueDto.id,
        status: queueDto.status,
        deduplicated: response.deduplicated,
        queue_item: queueDto,
      };
    },

    async listSendQueueWithWorker(
      request: SendQueueListRequest,
    ): Promise<{ items: SendQueueDto[]; worker: SendQueueWorkerStatusDto }> {
      const response = await transport.listMailSendQueue({
        limit: request.limit ?? undefined,
        accountId: request.account_id ?? undefined,
        status: request.status ?? undefined,
      });
      return {
        items: response.items.map(toSendQueueDto),
        worker: toSendQueueWorkerStatusDto(response.worker),
      };
    },

    async listSendQueue(request: SendQueueListRequest): Promise<SendQueueDto[]> {
      return (await this.listSendQueueWithWorker(request)).items;
    },

    async getSendQueueItem(queueId: string): Promise<SendQueueDto> {
      return toSendQueueDto((await transport.getMailSendQueueItem(queueId)).queueItem);
    },

    async runSendQueueItem(request: SendQueueRunItemRequest): Promise<SendQueueDto> {
      return toSendQueueDto((await transport.runMailSendQueueItem(request.queue_id)).queueItem);
    },

    async runSendQueueOnce(): Promise<SendQueueWorkerRunResult> {
      return toSendQueueWorkerRunResult((await transport.runMailSendQueueOnce()).runResult);
    },

    async runSendQueueDueBatch(
      request: SendQueueRunDueBatchRequest,
    ): Promise<SendQueueWorkerRunResult> {
      return toSendQueueWorkerRunResult(
        (await transport.runMailSendQueueDueBatch({ limit: request.limit })).runResult,
      );
    },

    async cancelSendQueueItem(request: SendQueueCancelItemRequest): Promise<SendQueueDto> {
      const response = await transport.cancelMailSendQueueItem(request.queue_id, {
        expectedVersion: request.expected_version,
      });
      return toSendQueueDto(response.queueItem);
    },

    async retrySendQueueItem(request: SendQueueRetryItemRequest): Promise<SendQueueDto> {
      const response = await transport.retryMailSendQueueItem(request.queue_id, {
        expectedVersion: request.expected_version,
        confirmDeliveryUnknown: request.confirm_delivery_unknown,
      });
      return toSendQueueDto(response.queueItem);
    },

    async reopenScheduledSend(messageId: string): Promise<MessageDetailDto> {
      const response = await transport.reopenScheduledSend(messageId);
      return toMessageDetailDto(response.message);
    },
  };
}
