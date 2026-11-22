import { normalSendFixture, SMTP_PASSWORD } from "./normal-send-fixture.mjs";
import { createService, expect } from "./agent-services-fixture.mjs";

export async function agentTasksFixture(browser = false, testEntry = new URL("./agent-tasks-test-worker.ts", import.meta.url), resources = {}, transport) {
  const t = await normalSendFixture(browser, resources, testEntry, transport), { h, alice } = t;
  try {
    const accountId = crypto.randomUUID();
    expect(await h.request(`/api/v1/agent-accounts/${accountId}`, { method: "PUT", cookie: alice.cookie, headers: { "idempotency-key": crypto.randomUUID() },
      body: { expectedRevision: 0, emailAddress: "sender@example.test", displayName: "任务专用邮箱", endpointId: "example", username: "Alice", password: "Synthetic-Agent-IMAP-password", enabled: true } }), 201);
    expect(await h.request(`/api/v1/agent-accounts/${accountId}/smtp`, { method: "PUT", cookie: alice.cookie, headers: { "idempotency-key": crypto.randomUUID() },
      body: { expectedRevision: 1, smtpRevision: 0, endpointId: "example", username: "Alice", password: SMTP_PASSWORD, enabled: true } }));
    const serviceId = expect(await createService(h, alice, { displayName: "远程任务服务", emailAddress: "agent@example.test", trustLevel: "trusted" }), 201).operation.serviceId;
    const input = { serviceId, serviceVersion: 1, senderAccountId: accountId, accountRevision: 1, smtpRevision: 1, subject: "迁移任务验收", text: "请处理这个合成任务\n正文" };
    return { ...t, accountId, serviceId, input,
      enqueue: (body = input, key = crypto.randomUUID(), extra = {}) => h.request("/api/v1/agent-tasks", { method: "POST", cookie: alice.cookie, body, ...extra,
        headers: { "idempotency-key": key, ...extra.headers } }),
      read: id => h.request(`/api/v1/agent-tasks/${id}`, { cookie: alice.cookie }),
      run: () => h.scheduled(Date.now(), "* * * * *"),
    };
  } catch (error) { await t.close(); throw error; }
}
