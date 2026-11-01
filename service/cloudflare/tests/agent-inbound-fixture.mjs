import { agentReviewFixture } from "./agent-review-fixture.mjs";
export async function agentInboundFixture(options = {}) {
  const t = await agentReviewFixture(options);
  return { ...t, inputInbound: (fields = {}) => ({ accountRevision: 1, epochId: t.incoming?.epochId, expectedRevision: 0,
    serviceId: t.serviceId, serviceVersion: 1, confirmRestricted: false, ...fields }),
  createInbound: (body, key = crypto.randomUUID(), extra = {}) => t.h.request(`${t.base}/messages/${t.incoming.id}/inbound-thread`, {
    method: "PUT", cookie: t.alice.cookie, body, ...extra, headers: { "idempotency-key": key, ...extra.headers } }),
  inboundReceipt: (key, extra = {}) => t.h.request(`${t.base}/inbound-thread-operations/${key}`, { cookie: t.alice.cookie, ...extra }),
  thread: (id, extra = {}) => t.h.request(`/api/v1/agent-threads/${id}`, { cookie: t.alice.cookie, ...extra }),
  threads: (query = "", extra = {}) => t.h.request(`/api/v1/agent-threads${query}`, { cookie: t.alice.cookie, ...extra }),
  state: (id, state, revision = 1, key = crypto.randomUUID(), extra = {}) => t.h.request(`/api/v1/agent-threads/${id}/state`, {
    method: "PUT", cookie: t.alice.cookie, body: { expectedRevision: revision, state }, ...extra, headers: { "idempotency-key": key, ...extra.headers } }),
  };
}
