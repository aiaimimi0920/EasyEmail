import assert from "node:assert/strict";
import { googleFixture, EMAIL } from "./google-oauth-fixture.mjs";
import { createService, expect } from "./agent-services-fixture.mjs";

export const entered = gate => Promise.race([gate.entered, new Promise((_, reject) => {
  const timer = setTimeout(() => reject(Error("Agent Google gate not entered")), 10000); timer.unref();
})]);
export async function agentGoogleFixture(browser = false) {
  const f = await googleFixture(browser, true, { scope: "agent", worker: new URL("./agent-google-oauth-test-worker.ts", import.meta.url) });
  const write = (path, body, key = crypto.randomUUID(), extra = {}) => f.h.request(path, { method: "POST", cookie: f.alice.cookie,
    body, ...extra, headers: { "idempotency-key": key, ...extra.headers } });
  let input;
  return { ...f, write,
    get taskInput() { assert.ok(input); return input; },
    async setup() {
      await f.authorize(); expect(await write(`${f.path}/smtp`, { expectedRevision: 2, smtpRevision: 0, endpointId: "google", username: EMAIL, enabled: true }, undefined, { method: "PUT" }));
      const serviceId = expect(await createService(f.h, f.alice, { displayName: "OAuth Agent", emailAddress: "agent@example.test", trustLevel: "trusted" }), 201).operation.serviceId;
      input = { serviceId, serviceVersion: 1, senderAccountId: f.id, accountRevision: 2, smtpRevision: 1, subject: "Google Agent task", text: "合成任务正文" };
    },
    check: (revision = 2) => write(`${f.path}/test`, { expectedRevision: revision }),
    receive: (revision = 2, key, extra) => write(`${f.path}/sync`, { expectedRevision: revision }, key, extra),
    enqueue: (key, body = input) => write("/api/v1/agent-tasks", body, key),
    task: async id => expect(await f.h.request(`/api/v1/agent-tasks/${id}`, { cookie: f.alice.cookie })).task,
    tick: () => f.h.scheduled(Date.now(), "* * * * *"),
    auto: (expectedAccountRevision = 2, expectedRevision = 0, enabled = true) => write(`${f.path}/auto-inbox`, {
      expectedAccountRevision, expectedRevision, enabled, intervalMinutes: 5, persistentAuthorization: enabled }, undefined, { method: "PUT" }),
    async followupInput(id, fields = {}) {
      const context = expect(await f.h.request(`/api/v1/agent-threads/${id}/followup-context`, { cookie: f.alice.cookie })).context;
      return { ...input, senderAccountId: context.senderAccountId, accountRevision: context.accountRevision, smtpRevision: context.smtpRevision,
        serviceId: context.serviceId, serviceVersion: context.serviceVersion, expectedThreadRevision: context.threadRevision,
        replyToType: "task", replyToId: id, confirmUncertain: false, ...fields };
    },
  };
}
