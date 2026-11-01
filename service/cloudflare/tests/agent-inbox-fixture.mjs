import { normalSyncFixture } from "./normal-sync-fixture.mjs";
export async function agentInboxFixture(options = {}) {
  const t = await normalSyncFixture({ testEntry: "./agent-inbox-test-worker.ts", ...options, public: true, agent: true }), base = `/api/v1/agent-accounts/${t.id}`;
  return { ...t, base,
    receive: (key = crypto.randomUUID(), revision = 1, extra = {}) => t.h.request(`${base}/sync`, { method: "POST", cookie: t.alice.cookie,
      body: { expectedRevision: revision }, ...extra, headers: { "idempotency-key": key, ...extra.headers } }),
    receipt: key => t.h.request(`${base}/sync-requests/${key}`, { cookie: t.alice.cookie }),
    messages: (query = "", extra = {}) => t.h.request(`${base}/messages${query}`, { cookie: t.alice.cookie, ...extra }),
    message: (id, extra = {}) => t.h.request(`${base}/messages/${id}`, { cookie: t.alice.cookie, ...extra }),
  };
}
export function agentReply(messageId, options = {}) {
  return new TextEncoder().encode(`From: ${options.from ?? "Agent <agent@example.test>"}\r\nTo: alice@example.test\r\nSubject: ${options.subject ?? "任务回复"}\r\nMessage-ID: <${crypto.randomUUID()}@example.test>\r\n` +
    `${options.headers ?? `In-Reply-To: ${messageId}\r\n`}Content-Type: text/plain; charset=utf-8\r\n\r\n${options.text ?? "收到任务，请人工确认"}`);
}
