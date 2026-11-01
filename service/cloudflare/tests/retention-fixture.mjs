import { adminFixture, ok } from "./admin-fixture.mjs";

export async function retentionFixture() {
  const a = await adminFixture(), { h, admin } = a;
  const current = async () => ok(await h.request("/api/v1/admin/retention", { cookie: admin.cookie }));
  return { ...a, retention: current,
    async policy(changes, extra = {}) {
      const state = await current();
      return h.request("/api/v1/admin/retention", { cookie: admin.cookie, method: "PUT", body: {
        expectedRevision: state.revision, policy: { ...state.policy, ...changes }, confirm: "APPLY RETENTION", ...extra } });
    },
    async preview(policy) {
      const state = await current();
      return h.request("/api/v1/admin/retention/preview", { cookie: admin.cookie, method: "POST", body: {
        expectedRevision: state.revision, policy: policy ?? state.policy } });
    },
    async run(key = crypto.randomUUID(), revision) {
      const state = revision === undefined ? await current() : null;
      return h.request("/api/v1/admin/retention/run", { cookie: admin.cookie, method: "POST", headers: { "idempotency-key": key },
        body: { expectedRevision: revision ?? state.revision, confirm: "RUN RETENTION" } });
    },
  };
}

export async function seedRetentionMessage(h, userId, box, { age = 3, trash = null } = {}) {
  const id = crypto.randomUUID(), now = Math.floor(Date.now() / 1000);
  await h.db.prepare(`INSERT INTO messages(id,user_id,mailbox_id,remote_id,fingerprint,sender,recipient,subject,text_body,html_body,attachments,observed_at,trashed_at,rfc_message_id)
    VALUES (?,?,?,?,?,'sender@example.test',?,'Synthetic retention subject','Synthetic retention text','<b>Synthetic</b>','[]',?,?,'<retention@example.test>')`)
    .bind(id, userId, box.id, crypto.randomUUID(), crypto.randomUUID(), box.address, now - age * 86400, trash === null ? null : now - trash * 86400).run();
  return id;
}
