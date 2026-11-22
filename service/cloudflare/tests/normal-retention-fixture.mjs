import assert from "node:assert/strict";
import { normalSyncFixture } from "./normal-sync-fixture.mjs";

export async function normalRetentionFixture(options = {}) {
  const t = await normalSyncFixture({ public: true, ...options }), { h, alice, id } = t;
  await h.db.prepare("INSERT INTO platform_admins(user_id,created_at) VALUES (?,unixepoch())").bind(alice.id).run();
  const state = async () => (await h.request("/api/v1/admin/retention", { cookie: alice.cookie })).body;
  const root = `/api/v1/normal-accounts/${id}`;
  return { ...t, root, retention: state,
    async policy(changes) {
      const current = await state();
      const r = await h.request("/api/v1/admin/retention", { cookie: alice.cookie, method: "PUT", body: {
        expectedRevision: current.revision, policy: { ...current.policy, ...changes }, confirm: "APPLY RETENTION" } });
      assert.equal(r.status, 200, r.text); return r.body;
    },
    async preview() {
      const s = await state(); return h.request("/api/v1/admin/retention/preview", { cookie: alice.cookie, method: "POST",
        body: { expectedRevision: s.revision, policy: s.policy } });
    },
    async run(key = crypto.randomUUID(), extra = {}) {
      const s = await state(); return h.request("/api/v1/admin/retention/run", { cookie: alice.cookie, method: "POST",
        headers: { "idempotency-key": key }, body: { expectedRevision: s.revision, confirm: "RUN RETENTION" }, ...extra });
    },
    async receive() {
      const key = crypto.randomUUID();
      const result = await h.request(`${root}/sync`, { cookie: alice.cookie, method: "POST",
        headers: { "idempotency-key": key }, body: { expectedRevision: 1 } });
      assert.equal(result.status, 200, result.text); assert.equal(result.body.request.state, "committed", result.text);
      const rows = (await h.db.prepare("SELECT * FROM normal_inbox_messages WHERE account_id=? ORDER BY uid").bind(id).all()).results;
      return { key, result: result.body.request, rows };
    },
    async age(messageId) { await h.db.prepare("UPDATE normal_inbox_messages SET observed_at=unixepoch()-259200 WHERE id=?").bind(messageId).run(); },
  };
}
