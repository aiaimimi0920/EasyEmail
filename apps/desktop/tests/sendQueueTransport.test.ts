import assert from "node:assert/strict";
import test from "node:test";

import { createEasyEmailHttpClient } from "../src/api/easyEmailHttpClient.ts";

test("desktop HTTP client wires M5 SMTP test, send queue routes, Idempotency-Key header, and scheduled reopen", async () => {
  const requests: Array<{ url: string; method: string; headers: Record<string, string>; body?: unknown }> = [];
  const client = createEasyEmailHttpClient({
    baseUrl: "http://127.0.0.1:18081",
    bearerToken: "desktop-runtime-token",
    fetch: async (input, init) => {
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await client.testMailAccountSmtp({ accountId: "acct_1", credentialRefId: "cred_1" });
  await client.enqueueMailSend(
    {
      accountId: "acct_1",
      targetAddress: "to@example.com",
      subject: "Hello",
      bodyText: "World",
    },
    { idempotencyKey: "idem-key-1" },
  );
  await client.listMailSendQueue({ accountId: "acct_1", status: "queued", limit: 25 });
  await client.getMailSendQueueItem("queue/1");
  await client.runMailSendQueueItem("queue/1");
  await client.cancelMailSendQueueItem("queue/1", { expectedVersion: 1 });
  await client.retryMailSendQueueItem("queue/1", { expectedVersion: 2, confirmDeliveryUnknown: true });
  await client.runMailSendQueueOnce();
  await client.runMailSendQueueDueBatch({ limit: 10 });
  await client.reopenScheduledSend("msg/1");

  assert.equal(requests[0]?.url, "http://127.0.0.1:18081/mail/accounts/smtp/test");
  assert.equal(requests[0]?.method, "POST");
  assert.equal(requests[1]?.url, "http://127.0.0.1:18081/mail/send-queue");
  assert.equal(requests[1]?.headers["idempotency-key"], "idem-key-1");
  assert.equal(
    requests[2]?.url,
    "http://127.0.0.1:18081/mail/send-queue?accountId=acct_1&status=queued&limit=25",
  );
  assert.equal(requests[3]?.url, "http://127.0.0.1:18081/mail/send-queue/queue%2F1");
  assert.equal(requests[4]?.url, "http://127.0.0.1:18081/mail/send-queue/queue%2F1/run");
  assert.equal(requests[5]?.url, "http://127.0.0.1:18081/mail/send-queue/queue%2F1/cancel");
  assert.equal(requests[6]?.url, "http://127.0.0.1:18081/mail/send-queue/queue%2F1/retry");
  assert.equal(requests[7]?.url, "http://127.0.0.1:18081/mail/send-queue/run-once");
  assert.equal(requests[8]?.url, "http://127.0.0.1:18081/mail/send-queue/run-due");
  assert.equal(
    requests[9]?.url,
    "http://127.0.0.1:18081/mail/messages/msg%2F1/scheduled-send/reopen",
  );
});
