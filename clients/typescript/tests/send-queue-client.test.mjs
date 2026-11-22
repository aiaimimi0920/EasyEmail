import assert from "node:assert/strict";
import test from "node:test";

import { EasyEmailClient } from "../dist/index.js";

test("M5 send queue, SMTP test, and scheduled reopen SDK methods use canonical HTTP routes and headers", async () => {
  const calls = [];
  const client = new EasyEmailClient({
    baseUrl: "http://127.0.0.1:18081",
    apiKey: "sdk-m5-token",
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body });
      const pathname = new URL(url).pathname;
      if (pathname === "/mail/accounts/smtp/test") {
        return new Response(
          JSON.stringify({ result: { authenticated: true, capabilitySummary: "AUTH PLAIN" } }),
          { status: 200 },
        );
      }
      if (pathname === "/mail/send-queue" && init.method === "POST") {
        return new Response(
          JSON.stringify({
            messageId: "msg-1",
            deduplicated: false,
            queueItem: { id: "send-1", status: "queued" },
          }),
          { status: 200 },
        );
      }
      if (pathname === "/mail/send-queue" && init.method === "GET") {
        return new Response(
          JSON.stringify({
            items: [{ id: "send-1", status: "queued" }],
            worker: { enabled: true, running: false },
          }),
          { status: 200 },
        );
      }
      if (pathname === "/mail/send-queue/run-once") {
        return new Response(
          JSON.stringify({
            runResult: { processedCount: 1, sentCount: 1, retryCount: 0, failedCount: 0 },
          }),
          { status: 200 },
        );
      }
      if (pathname === "/mail/send-queue/run-due") {
        return new Response(
          JSON.stringify({
            runResult: { processedCount: 2, sentCount: 2, retryCount: 0, failedCount: 0 },
          }),
          { status: 200 },
        );
      }
      if (pathname.endsWith("/scheduled-send/reopen")) {
        return new Response(
          JSON.stringify({
            message: { id: "msg-1", localFolder: "drafts" },
            queueItem: { id: "send-1", status: "cancelled" },
          }),
          { status: 200 },
        );
      }
      if (pathname.endsWith("/run")) {
        return new Response(
          JSON.stringify({
            queueItem: { id: "send-1", status: "sent" },
            runResult: { processedCount: 1, sentCount: 1, retryCount: 0, failedCount: 0 },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ queueItem: { id: "send-1", status: "cancelled" } }),
        { status: 200 },
      );
    },
  });

  const smtpTest = await client.testMailAccountSmtp({
    accountId: "acct-1",
    credentialRefId: "cred-1",
  });
  assert.equal(smtpTest.authenticated, true);

  const enqueued = await client.enqueueMailSend(
    {
      accountId: "acct-1",
      targetAddress: "to@example.com",
      subject: "Subject",
      bodyText: "Body",
    },
    "idem-sdk-1",
  );
  assert.equal(enqueued.messageId, "msg-1");
  assert.equal(calls[1].headers["Idempotency-Key"], "idem-sdk-1");

  const listed = await client.listMailSendQueue({ status: "queued", limit: 25 });
  assert.equal(listed.items.length, 1);
  assert.match(calls[2].url, /\/mail\/send-queue\?status=queued&limit=25$/);

  await client.getMailSendQueueItem("send/1");
  assert.match(calls[3].url, /\/mail\/send-queue\/send%2F1$/);

  const ranItem = await client.runMailSendQueueItem("send/1");
  assert.equal(ranItem.queueItem.status, "sent");

  const ranOnce = await client.runMailSendQueueOnce();
  assert.equal(ranOnce.sentCount, 1);

  const ranDue = await client.runMailSendQueueDueBatch({ limit: 10 });
  assert.equal(ranDue.sentCount, 2);

  await client.cancelMailSendQueueItem("send-1", { expectedVersion: 1 });
  await client.retryMailSendQueueItem("send-1", { confirmDeliveryUnknown: true });
  const reopened = await client.reopenScheduledSend("msg/1");
  assert.equal(reopened.message.localFolder, "drafts");
});
