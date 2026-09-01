import type { InvokeCommand } from "./invokeCommand";

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
  next_retry_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
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

export type SendQueueListRequest = {
  limit: number | null;
};

export type SendQueueRunItemRequest = {
  queue_id: string;
};

export type SendQueueRunDueBatchRequest = {
  limit: number | null;
};

export function createSendQueueClient(invokeCommand: InvokeCommand) {
  return {
    listSendQueue(request: SendQueueListRequest): Promise<SendQueueDto[]> {
      return invokeCommand<SendQueueDto[]>("send_queue_list", { request });
    },
    runSendQueueItem(request: SendQueueRunItemRequest): Promise<SendQueueDto> {
      return invokeCommand<SendQueueDto>("send_queue_run_item", { request });
    },
    runSendQueueOnce(): Promise<SendQueueWorkerRunResult> {
      return invokeCommand<SendQueueWorkerRunResult>("send_queue_run_once");
    },
    runSendQueueDueBatch(
      request: SendQueueRunDueBatchRequest,
    ): Promise<SendQueueWorkerRunResult> {
      return invokeCommand<SendQueueWorkerRunResult>("send_queue_run_due_batch", {
        request,
      });
    },
  };
}
