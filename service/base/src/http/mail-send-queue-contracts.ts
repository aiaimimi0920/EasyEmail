import type {
  MailScheduledSendReopenResult,
  MailSendEnqueueInput,
  MailSendEnqueueResult,
  MailSendQueueCancelInput,
  MailSendQueueItem,
  MailSendQueueListQuery,
  MailSendQueueRetryInput,
  MailSendQueueRunBatchInput,
  MailSendQueueWorkerRunResult,
  MailSendQueueWorkerStatus,
} from "../domain/mail-send-queue.js";
import type {
  MailAccountSmtpTestRequest,
  MailSmtpConnectionTestResult,
} from "../service/account-connectivity.js";

export type TestMailAccountSmtpHttpRequest = MailAccountSmtpTestRequest;
export interface TestMailAccountSmtpHttpResponse {
  result: MailSmtpConnectionTestResult;
}

export type EnqueueMailSendHttpRequest = MailSendEnqueueInput;
export type EnqueueMailSendHttpResponse = MailSendEnqueueResult;

export type ListMailSendQueueHttpRequest = MailSendQueueListQuery;
export interface ListMailSendQueueHttpResponse {
  items: MailSendQueueItem[];
  nextCursor?: string;
  worker: MailSendQueueWorkerStatus;
}

export interface GetMailSendQueueItemHttpResponse {
  queueItem: MailSendQueueItem;
}

export interface RunMailSendQueueItemHttpResponse {
  queueItem: MailSendQueueItem;
  runResult: MailSendQueueWorkerRunResult;
}

export interface RunMailSendQueueWorkerHttpResponse {
  runResult: MailSendQueueWorkerRunResult;
}

export type RunMailSendQueueDueBatchHttpRequest = MailSendQueueRunBatchInput;
export type CancelMailSendQueueItemHttpRequest = MailSendQueueCancelInput;
export interface CancelMailSendQueueItemHttpResponse {
  queueItem: MailSendQueueItem;
}

export type RetryMailSendQueueItemHttpRequest = MailSendQueueRetryInput;
export interface RetryMailSendQueueItemHttpResponse {
  queueItem: MailSendQueueItem;
}

export type ReopenScheduledSendHttpResponse = MailScheduledSendReopenResult;
