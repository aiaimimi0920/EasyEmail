import { normalSyncFixture } from "./normal-sync-fixture.mjs";

export async function normalAccessFixture(options = {}) {
  const t = await normalSyncFixture({ ...options, public: true }), base = `/api/v1/normal-accounts/${t.id}`;
  return { ...t, base,
    receive(key = crypto.randomUUID(), revision = 1, extra = {}) { return t.h.request(`${base}/sync`, { method: "POST", cookie: t.alice.cookie,
      headers: { "idempotency-key": key }, body: { expectedRevision: revision }, ...extra }); },
    messages(query = "", extra = {}) { return t.h.request(`${base}/messages${query}`, { cookie: t.alice.cookie, ...extra }); },
    message(id, extra = {}) { return t.h.request(`${base}/messages/${id}`, { cookie: t.alice.cookie, ...extra }); },
    receipt(key, extra = {}) { return t.h.request(`${base}/sync-requests/${key}`, { cookie: t.alice.cookie, ...extra }); },
    async binary(id, suffix, extra = {}) { const response = await fetch(`${t.h.baseUrl.origin}${base}/messages/${id}/${suffix}`, {
      headers: { cookie: t.alice.cookie, connection: "close", ...extra }, redirect: "manual" }); return { response, bytes: Buffer.from(await response.arrayBuffer()) }; },
  };
}
