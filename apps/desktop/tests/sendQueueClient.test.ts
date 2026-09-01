import assert from "node:assert/strict";
import test from "node:test";

import {
  createSendQueueClient,
  type SendQueueDto,
  type SendQueueListRequest,
  type SendQueueRunDueBatchRequest,
  type SendQueueRunItemRequest,
  type SendQueueWorkerRunResult,
} from "../src/api/sendQueueClient.ts";
import type { InvokeCommand } from "../src/api/invokeCommand.ts";

type InvokeCall =
  | { command: string }
  | { command: string; args: Record<string, unknown> };

function createFakeInvoke(responses: ReadonlyMap<string, unknown>) {
  const calls: InvokeCall[] = [];
  const invokeCommand: InvokeCommand = async <T>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<T> => {
    calls.push(args === undefined ? { command } : { command, args });
    if (!responses.has(command)) {
      throw new Error(`Unexpected command: ${command}`);
    }
    return responses.get(command) as T;
  };

  return { calls, invokeCommand };
}

const queueItem: SendQueueDto = {
  id: "queue-1",
  account_id: "account-1",
  source_id: "source-1",
  message_id: "message-1",
  target_address: "recipient@example.com",
  cc_addresses: ["cc-one@example.com", "cc-two@example.com"],
  bcc_addresses: ["bcc@example.com"],
  subject: "Queued message",
  status: "queued",
  attempt_count: 0,
  next_retry_at: null,
  last_error_code: null,
  last_error_message: null,
  created_at: "2026-07-24T09:00:00Z",
  updated_at: "2026-07-24T09:00:00Z",
  sent_at: null,
};

test("lists the send queue with send_queue_list and exactly the wrapped request payload", async () => {
  const request: SendQueueListRequest = { limit: 25 };
  const queue = [queueItem];
  const { calls, invokeCommand } = createFakeInvoke(
    new Map<string, unknown>([["send_queue_list", queue]]),
  );

  const result = await createSendQueueClient(invokeCommand).listSendQueue(request);

  assert.strictEqual(result, queue);
  assert.deepEqual(calls, [
    {
      command: "send_queue_list",
      args: { request },
    },
  ]);
  const listCall = calls[0];
  assert.ok("args" in listCall);
  assert.deepEqual(Object.keys(listCall.args), ["request"]);
  assert.strictEqual(listCall.args.request, request);
});

test("runs one targeted queue item with send_queue_run_item and returns the queue DTO", async () => {
  const request: SendQueueRunItemRequest = { queue_id: queueItem.id };
  const sentQueueItem: SendQueueDto = {
    ...queueItem,
    status: "sent",
    attempt_count: 1,
    updated_at: "2026-07-24T09:01:00Z",
    sent_at: "2026-07-24T09:01:00Z",
  };
  const { calls, invokeCommand } = createFakeInvoke(
    new Map<string, unknown>([["send_queue_run_item", sentQueueItem]]),
  );

  const result = await createSendQueueClient(invokeCommand).runSendQueueItem(request);

  assert.strictEqual(result, sentQueueItem);
  assert.deepEqual(calls, [
    {
      command: "send_queue_run_item",
      args: { request },
    },
  ]);
  const runItemCall = calls[0];
  assert.ok("args" in runItemCall);
  assert.deepEqual(Object.keys(runItemCall.args), ["request"]);
  assert.strictEqual(runItemCall.args.request, request);
});

test("runs the send queue worker once with send_queue_run_once and no argument object", async () => {
  const workerResult: SendQueueWorkerRunResult = {
    processed_count: 3,
    sent_count: 2,
    retry_count: 1,
    failed_count: 0,
  };
  const { calls, invokeCommand } = createFakeInvoke(
    new Map<string, unknown>([["send_queue_run_once", workerResult]]),
  );

  const result = await createSendQueueClient(invokeCommand).runSendQueueOnce();

  assert.strictEqual(result, workerResult);
  assert.deepEqual(calls, [{ command: "send_queue_run_once" }]);
  assert.equal("args" in calls[0], false);
});

test("runs the due send queue batch with send_queue_run_due_batch and exactly the wrapped request payload", async () => {
  const request: SendQueueRunDueBatchRequest = { limit: 10 };
  const workerResult: SendQueueWorkerRunResult = {
    processed_count: 4,
    sent_count: 3,
    retry_count: 0,
    failed_count: 1,
  };
  const { calls, invokeCommand } = createFakeInvoke(
    new Map<string, unknown>([["send_queue_run_due_batch", workerResult]]),
  );

  const result = await createSendQueueClient(invokeCommand).runSendQueueDueBatch(request);

  assert.strictEqual(result, workerResult);
  assert.deepEqual(calls, [
    {
      command: "send_queue_run_due_batch",
      args: { request },
    },
  ]);
  const dueBatchCall = calls[0];
  assert.ok("args" in dueBatchCall);
  assert.deepEqual(Object.keys(dueBatchCall.args), ["request"]);
  assert.strictEqual(dueBatchCall.args.request, request);
});

test("preserves a null list limit and passes the returned queue DTO through unchanged", async () => {
  const request: SendQueueListRequest = { limit: null };
  const queue = [queueItem];
  const { calls, invokeCommand } = createFakeInvoke(
    new Map<string, unknown>([["send_queue_list", queue]]),
  );

  const result = await createSendQueueClient(invokeCommand).listSendQueue(request);

  assert.deepEqual(calls, [
    {
      command: "send_queue_list",
      args: { request },
    },
  ]);
  assert.strictEqual(result, queue);
  assert.strictEqual(result[0], queueItem);
  assert.strictEqual(result[0].next_retry_at, null);
  assert.strictEqual(result[0].last_error_code, null);
  assert.strictEqual(result[0].last_error_message, null);
  assert.strictEqual(result[0].sent_at, null);
  assert.strictEqual(result[0].cc_addresses, queueItem.cc_addresses);
  assert.strictEqual(result[0].bcc_addresses, queueItem.bcc_addresses);
  assert.deepEqual(result[0].cc_addresses, [
    "cc-one@example.com",
    "cc-two@example.com",
  ]);
  assert.deepEqual(result[0].bcc_addresses, ["bcc@example.com"]);
});

test("propagates the exact invoke rejection object unchanged", async () => {
  const rejection = {
    code: "smtp_unavailable",
    message: "SMTP service is unavailable",
  };
  const invokeCommand: InvokeCommand = <T>(): Promise<T> =>
    Promise.reject<T>(rejection);

  await assert.rejects(
    createSendQueueClient(invokeCommand).runSendQueueDueBatch({ limit: null }),
    (caught: unknown) => {
      assert.strictEqual(caught, rejection);
      return true;
    },
  );
});
