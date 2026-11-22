import { agentInboxFixture } from "./agent-inbox-fixture.mjs";
export async function autoInboxFixture(options = {}) {
  const t = await agentInboxFixture(options), path = `${t.base}/auto-inbox`;
  return { ...t,
    config: (extra = {}) => t.h.request(path, { cookie: t.alice.cookie, ...extra }),
    configure: (body = {}, key = crypto.randomUUID(), extra = {}) => t.h.request(path, { method: "PUT", cookie: t.alice.cookie,
      body: { expectedAccountRevision: 1, expectedRevision: 0, enabled: true, intervalMinutes: 15, persistentAuthorization: true, ...body },
      ...extra, headers: { "idempotency-key": key, ...extra.headers } }),
    configReceipt: (key, extra = {}) => t.h.request(`/api/v1/agent-inbox-automation-operations/${key}`, { cookie: t.alice.cookie, ...extra }),
    tick: () => t.h.scheduled(Date.now(), "* * * * *"),
    due: () => t.h.db.prepare("UPDATE agent_inbox_automation SET next_due_at=unixepoch()-1 WHERE account_id=?").bind(t.id).run(),
  };
}
