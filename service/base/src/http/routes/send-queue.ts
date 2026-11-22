import { EasyEmailError } from "../../domain/errors.js";
import type { MailSendQueueStatus } from "../../domain/mail-send-queue.js";
import {
  EASY_EMAIL_HTTP_ROUTES,
  type CancelMailSendQueueItemHttpRequest,
  type EnqueueMailSendHttpRequest,
  type RetryMailSendQueueItemHttpRequest,
  type RunMailSendQueueDueBatchHttpRequest,
  type TestMailAccountSmtpHttpRequest,
} from "../contracts.js";
import type { EasyEmailHttpHandler } from "../handler.js";

export interface SendQueueRouteContext {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  handler: EasyEmailHttpHandler;
  readJsonBody<T>(): Promise<T>;
}

function decodeQueuePathSegment(rawSegment: string): string {
  try {
    return decodeURIComponent(rawSegment);
  } catch {
    throw new EasyEmailError("INVALID_SEND_MESSAGE", "Send queue path encoding is invalid.");
  }
}

function parsePositiveIntegerQuery(
  value: string | undefined,
  fieldName: string,
): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (!/^[1-9]\d*$/.test(value)) {
    throw new EasyEmailError("INVALID_QUERY", `${fieldName} must be a positive integer.`);
  }
  return Number(value);
}

function readSingleHeader(
  headers: Record<string, string | string[] | undefined>,
  headerName: string,
): string | undefined {
  const raw = headers[headerName.toLowerCase()];
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) {
    throw new EasyEmailError("INVALID_SEND_MESSAGE", `Duplicate ${headerName} headers are not allowed.`);
  }
  return raw;
}

function extractQueueItemId(path: string): string | undefined {
  if (
    path === EASY_EMAIL_HTTP_ROUTES.sendQueueRunOnce
    || path === EASY_EMAIL_HTTP_ROUTES.sendQueueRunDue
  ) {
    return undefined;
  }
  const matched = path.match(/^\/mail\/send-queue\/([^/]+)$/);
  return matched?.[1] ? decodeQueuePathSegment(matched[1]) : undefined;
}

function extractQueueItemActionId(
  path: string,
  action: "run" | "cancel" | "retry",
): string | undefined {
  const matched = path.match(new RegExp(`^\\/mail\\/send-queue\\/([^/]+)\\/${action}$`));
  return matched?.[1] ? decodeQueuePathSegment(matched[1]) : undefined;
}

function extractScheduledSendReopenMessageId(path: string): string | undefined {
  const matched = path.match(/^\/mail\/messages\/([^/]+)\/scheduled-send\/reopen$/);
  return matched?.[1] ? decodeQueuePathSegment(matched[1]) : undefined;
}

export async function handleSendQueueRoute(
  context: SendQueueRouteContext,
): Promise<unknown | undefined> {
  const { method, path, query, headers, handler, readJsonBody } = context;

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.testAccountSmtp) {
    return handler.testMailAccountSmtp(await readJsonBody<TestMailAccountSmtpHttpRequest>());
  }

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.sendQueue) {
    const idempotencyKey = readSingleHeader(headers, "idempotency-key");
    return handler.enqueueMailSend(
      await readJsonBody<EnqueueMailSendHttpRequest>(),
      idempotencyKey,
    );
  }

  if (method === "GET" && path === EASY_EMAIL_HTTP_ROUTES.sendQueue) {
    return handler.listMailSendQueue({
      accountId: query.accountId || undefined,
      status: (query.status || undefined) as MailSendQueueStatus | undefined,
      limit: parsePositiveIntegerQuery(query.limit, "limit"),
      cursor: query.cursor || undefined,
    });
  }

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.sendQueueRunOnce) {
    return handler.runMailSendQueueOnce();
  }

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.sendQueueRunDue) {
    return handler.runMailSendQueueDueBatch(
      await readJsonBody<RunMailSendQueueDueBatchHttpRequest>(),
    );
  }

  if (method === "GET") {
    const queueItemId = extractQueueItemId(path);
    if (queueItemId) {
      return handler.getMailSendQueueItem(queueItemId);
    }
  }

  if (method === "POST") {
    const runId = extractQueueItemActionId(path, "run");
    if (runId) {
      return handler.runMailSendQueueItem(runId);
    }
    const cancelId = extractQueueItemActionId(path, "cancel");
    if (cancelId) {
      return handler.cancelMailSendQueueItem(
        cancelId,
        await readJsonBody<CancelMailSendQueueItemHttpRequest>(),
      );
    }
    const retryId = extractQueueItemActionId(path, "retry");
    if (retryId) {
      return handler.retryMailSendQueueItem(
        retryId,
        await readJsonBody<RetryMailSendQueueItemHttpRequest>(),
      );
    }
    const reopenMessageId = extractScheduledSendReopenMessageId(path);
    if (reopenMessageId) {
      return handler.reopenScheduledSend(reopenMessageId);
    }
  }

  return undefined;
}
