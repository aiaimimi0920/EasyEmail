import type { EasyEmailRequestTransport } from "./easyEmailHttpTransport.ts";
import { EASY_EMAIL_CORE_ROUTES } from "./easyEmailRoutes.ts";
import type {
  EasyEmailMailScheduledSendReopenResponse,
  EasyEmailMailSendEnqueueRequest,
  EasyEmailMailSendEnqueueResponse,
  EasyEmailMailSendQueueCancelRequest,
  EasyEmailMailSendQueueCancelResponse,
  EasyEmailMailSendQueueItemResponse,
  EasyEmailMailSendQueueListQuery,
  EasyEmailMailSendQueueListResponse,
  EasyEmailMailSendQueueRetryRequest,
  EasyEmailMailSendQueueRetryResponse,
  EasyEmailMailSendQueueRunBatchRequest,
  EasyEmailMailSendQueueRunItemResponse,
  EasyEmailMailSendQueueRunWorkerResponse,
} from "./easyEmailSendQueueTypes.ts";

export function createEasyEmailSendQueueResources(request: EasyEmailRequestTransport) {
  return {
    enqueueMailSend(
      enqueueRequest: EasyEmailMailSendEnqueueRequest,
      options?: { idempotencyKey?: string },
    ): Promise<EasyEmailMailSendEnqueueResponse> {
      const idempotencyKey = options?.idempotencyKey?.trim();
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.sendQueue,
        headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
        body: enqueueRequest,
      });
    },
    listMailSendQueue(
      query: EasyEmailMailSendQueueListQuery = {},
    ): Promise<EasyEmailMailSendQueueListResponse> {
      return request({
        path: EASY_EMAIL_CORE_ROUTES.sendQueue,
        query,
      });
    },
    getMailSendQueueItem(queueItemId: string): Promise<EasyEmailMailSendQueueItemResponse> {
      return request({
        path: EASY_EMAIL_CORE_ROUTES.sendQueueItem(queueItemId),
      });
    },
    runMailSendQueueItem(queueItemId: string): Promise<EasyEmailMailSendQueueRunItemResponse> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.runSendQueueItem(queueItemId),
      });
    },
    cancelMailSendQueueItem(
      queueItemId: string,
      cancelRequest: EasyEmailMailSendQueueCancelRequest = {},
    ): Promise<EasyEmailMailSendQueueCancelResponse> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.cancelSendQueueItem(queueItemId),
        body: cancelRequest,
      });
    },
    retryMailSendQueueItem(
      queueItemId: string,
      retryRequest: EasyEmailMailSendQueueRetryRequest = {},
    ): Promise<EasyEmailMailSendQueueRetryResponse> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.retrySendQueueItem(queueItemId),
        body: retryRequest,
      });
    },
    runMailSendQueueOnce(): Promise<EasyEmailMailSendQueueRunWorkerResponse> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.sendQueueRunOnce,
      });
    },
    runMailSendQueueDueBatch(
      batchRequest: EasyEmailMailSendQueueRunBatchRequest = {},
    ): Promise<EasyEmailMailSendQueueRunWorkerResponse> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.sendQueueRunDue,
        body: batchRequest,
      });
    },
    reopenScheduledSend(messageId: string): Promise<EasyEmailMailScheduledSendReopenResponse> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.reopenScheduledSend(messageId),
      });
    },
  };
}
