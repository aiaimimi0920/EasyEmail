import assert from "node:assert/strict";
import test from "node:test";

import {
  createSendQueueClient,
  type SendQueueHttpTransport,
} from "../src/api/sendQueueClient.ts";
import type { EasyEmailMailSendQueueItem } from "../src/api/easyEmailHttpClient.ts";

function canonicalQueueItem(
  overrides: Partial<EasyEmailMailSendQueueItem> = {},
): EasyEmailMailSendQueueItem {
  return {
    id: "queue_1",
    accountId: "acct_1",
    accountScope: "normal",
    sourceId: "src_1",
    messageId: "msg_1",
    senderAddress: "sender@example.com",
    smtpHost: "smtp.example.com",
    smtpPort: 465,
    smtpSecurity: "tls",
    smtpUsername: "sender@example.com",
    credentialRefId: "cred_smtp_1",
    targetAddress: "recipient@example.com",
    ccAddresses: ["cc@example.com"],
    bccAddresses: ["bcc@example.com"],
    subject: "Queued subject",
    status: "queued",
    attemptCount: 0,
    version: 1,
    createdAt: "2026-09-04T00:00:00Z",
    updatedAt: "2026-09-04T00:00:00Z",
    ...overrides,
  };
}

function createTransport(): SendQueueHttpTransport & { calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    async enqueueMailSend(request, options) {
      calls.push({ method: "enqueueMailSend", args: [request, options] });
      return {
        messageId: "msg_1",
        queueItem: canonicalQueueItem({ scheduledAt: request.scheduledAt ?? undefined }),
        deduplicated: false,
      };
    },
    async listMailSendQueue(query) {
      calls.push({ method: "listMailSendQueue", args: [query] });
      return {
        items: [canonicalQueueItem()],
        worker: {
          enabled: true,
          running: false,
          intervalMs: 5000,
          leaseDurationMs: 60000,
          totalProcessedCount: 2,
          totalSentCount: 2,
          totalRetryCount: 0,
          totalFailedCount: 0,
        },
      };
    },
    async getMailSendQueueItem(queueItemId) {
      calls.push({ method: "getMailSendQueueItem", args: [queueItemId] });
      return { queueItem: canonicalQueueItem({ id: queueItemId }) };
    },
    async runMailSendQueueItem(queueItemId) {
      calls.push({ method: "runMailSendQueueItem", args: [queueItemId] });
      return {
        queueItem: canonicalQueueItem({ id: queueItemId, status: "sent", attemptCount: 1, sentAt: "2026-09-04T00:01:00Z" }),
        runResult: { processedCount: 1, sentCount: 1, retryCount: 0, failedCount: 0 },
      };
    },
    async cancelMailSendQueueItem(queueItemId, request) {
      calls.push({ method: "cancelMailSendQueueItem", args: [queueItemId, request] });
      return { queueItem: canonicalQueueItem({ id: queueItemId, status: "cancelled", version: 2 }) };
    },
    async retryMailSendQueueItem(queueItemId, request) {
      calls.push({ method: "retryMailSendQueueItem", args: [queueItemId, request] });
      return { queueItem: canonicalQueueItem({ id: queueItemId, status: "queued", version: 3 }) };
    },
    async runMailSendQueueOnce() {
      calls.push({ method: "runMailSendQueueOnce", args: [] });
      return { runResult: { processedCount: 1, sentCount: 1, retryCount: 0, failedCount: 0 } };
    },
    async runMailSendQueueDueBatch(request) {
      calls.push({ method: "runMailSendQueueDueBatch", args: [request] });
      return { runResult: { processedCount: 3, sentCount: 2, retryCount: 1, failedCount: 0 } };
    },
    async reopenScheduledSend(messageId) {
      calls.push({ method: "reopenScheduledSend", args: [messageId] });
      return {
        queueItem: canonicalQueueItem({ messageId, status: "cancelled", version: 2 }),
        message: {
          id: messageId,
          accountId: "acct_1",
          sourceRefId: "src_1",
          sourceKind: "local_draft",
          receivedAddress: "recipient@example.com",
          providerLabel: "Work",
          subject: "Queued subject",
          fromAddress: "sender@example.com",
          snippet: "Body",
          bodyText: "Body",
          bodyHtml: "<p>Body</p>",
          rawHtmlAvailable: false,
          bodyCacheState: "cached",
          hasAttachments: false,
          classification: "outgoing",
          lifecycleState: "draft",
          observedAt: "2026-09-04T00:02:00Z",
          draftCcAddresses: ["cc@example.com"],
          draftBccAddresses: [],
          isRead: true,
          isStarred: false,
          isArchived: false,
          isImportant: false,
          localFolder: "drafts",
          labels: [],
          version: 2,
        },
      };
    },
  };
}

test("maps enqueue, list with worker status, run, cancel, retry, and scheduled reopen over HTTP", async () => {
  const transport = createTransport();
  const client = createSendQueueClient(transport);

  const enqueued = await client.enqueueSend({
    account_id: "acct_1",
    target_address: "recipient@example.com",
    cc_addresses: ["cc@example.com"],
    bcc_addresses: ["bcc@example.com"],
    scheduled_at: "2026-09-04T01:00:00Z",
    subject: "Queued subject",
    body_text: "Body",
    body_html: "<p>Body</p>",
    idempotency_key: "idem-1",
  });
  assert.equal(enqueued.queue_id, "queue_1");
  assert.equal(enqueued.queue_item.scheduled_at, "2026-09-04T01:00:00Z");

  const listed = await client.listSendQueueWithWorker({ limit: 25 });
  assert.equal(listed.items.length, 1);
  assert.equal(listed.worker.enabled, true);
  assert.equal(listed.worker.total_sent_count, 2);

  const ran = await client.runSendQueueItem({ queue_id: "queue_1" });
  assert.equal(ran.status, "sent");

  const cancelled = await client.cancelSendQueueItem({ queue_id: "queue_1", expected_version: 1 });
  assert.equal(cancelled.status, "cancelled");

  const retried = await client.retrySendQueueItem({
    queue_id: "queue_1",
    expected_version: 2,
    confirm_delivery_unknown: true,
  });
  assert.equal(retried.status, "queued");

  const batchResult = await client.runSendQueueDueBatch({ limit: 10 });
  assert.deepEqual(batchResult, {
    processed_count: 3,
    sent_count: 2,
    retry_count: 1,
    failed_count: 0,
  });

  const reopened = await client.reopenScheduledSend("msg_1");
  assert.equal(reopened.local_folder, "drafts");
  assert.deepEqual(reopened.draft_cc_addresses, ["cc@example.com"]);
});
