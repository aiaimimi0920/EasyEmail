import { agentAssociationFixture } from "./agent-inbox-association-fixture.mjs";

export async function agentThreadsFixture(options = {}) {
  const t = await agentAssociationFixture(options);
  return { ...t,
    threads: (query = "", extra = {}) => t.h.request(`/api/v1/agent-threads${query}`, { cookie: t.alice.cookie, ...extra }),
    thread: (id, extra = {}) => t.h.request(`/api/v1/agent-threads/${id}`, { cookie: t.alice.cookie, ...extra }),
    state: (id, state, revision = 0, key = crypto.randomUUID(), extra = {}) => t.h.request(`/api/v1/agent-threads/${id}/state`, {
      method: "PUT", cookie: t.alice.cookie, body: { expectedRevision: revision, state }, ...extra, headers: { "idempotency-key": key, ...extra.headers } }),
    operation: (key, extra = {}) => t.h.request(`/api/v1/agent-thread-operations/${key}`, { cookie: t.alice.cookie, ...extra }),
  };
}
