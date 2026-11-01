import assert from "node:assert/strict";
import { test } from "node:test";
import { normalFolderInboxFixture } from "./normal-folder-inbox-fixture.mjs";

for (const mode of ["after-request", "before-commit", "after-commit", "after-put"]) {
  test(`folder sync reconciles ${mode} without duplicate connection or exposing staged content`, async () => {
    const t = await normalFolderInboxFixture({ testEntry: "./normal-folder-inbox-test-worker.ts" });
    try {
      const key = crypto.randomUUID(), result = await t.receive("Sent", key, { headers: { "idempotency-key": key, "x-test-folder-storage": mode } });
      assert.equal(result.status, 200, result.text);
      assert.equal(result.body.request.state, mode === "after-commit" ? "committed" : mode === "after-request" ? "pending" : "failed", result.text);
      const opens = t.opens.length, repeated = await t.receive("Sent", key);
      assert.deepEqual(repeated.body, result.body); assert.equal(t.opens.length, opens);
      assert.equal((await t.messages("Sent")).body.items.length, mode === "after-commit" ? 1 : 0);
      if (mode === "after-request") assert.equal(opens, 1, "only initial catalog discovery may have connected");
      assert.deepEqual((await t.h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
    } finally { await t.close(); }
  });
}

test("folder retention protects all live receive leases and invalidates only the purged folder cache generation", async () => {
  const t = await normalFolderInboxFixture();
  try {
    await t.h.db.prepare("INSERT INTO platform_admins(user_id,created_at) VALUES (?,unixepoch())").bind(t.alice.id).run();
    await t.receive("Sent"); await t.receive("&Ti1lhw-");
    await t.h.db.prepare("UPDATE normal_inbox_messages SET observed_at=unixepoch()-259200 WHERE server_folder_id=?").bind(t.folder("Sent").id).run();
    const policy = (await t.request("/api/v1/admin/retention")).body;
    const saved = await t.request("/api/v1/admin/retention", { method: "PUT", body: { expectedRevision: policy.revision,
      policy: { ...policy.policy, enabled: true, cacheDays: 1 }, confirm: "APPLY RETENTION" } });
    assert.equal(saved.status, 200, saved.text);
    const run = () => t.request("/api/v1/admin/retention/run", { method: "POST", headers: { "idempotency-key": crypto.randomUUID() },
      body: { expectedRevision: saved.body.revision, confirm: "RUN RETENTION" } });
    const lease = await t.h.db.prepare("SELECT * FROM normal_server_folder_state WHERE server_folder_id=?").bind(t.folder("&Ti1lhw-").id).first();
    await t.h.db.prepare("UPDATE normal_server_folder_state SET claim_token='retention-test',claim_revision=1,claim_lease_until=unixepoch()+90 WHERE server_folder_id=?")
      .bind(t.folder("&Ti1lhw-").id).run();
    assert.equal((await run()).body.run.counts.purgedNormalMessages, 0);
    await t.h.db.prepare("UPDATE normal_server_folder_state SET claim_token=NULL,claim_revision=NULL,claim_lease_until=NULL WHERE server_folder_id=?")
      .bind(t.folder("&Ti1lhw-").id).run();
    const row = await t.h.db.prepare("SELECT * FROM normal_inbox_messages WHERE server_folder_id=?").bind(t.folder("Sent").id).first();
    const result = await run(); assert.equal(result.status, 200, result.text); assert.equal(result.body.run.counts.purgedNormalMessages, 1);
    const state = await t.h.db.prepare("SELECT * FROM normal_server_folder_state WHERE server_folder_id=?").bind(t.folder("Sent").id).first();
    assert.equal(state.cache_generation, 1); assert.equal(state.after_uid, 7);
    assert.equal((await t.h.db.prepare("SELECT cache_generation FROM normal_server_folder_state WHERE server_folder_id=?").bind(lease.server_folder_id).first()).cache_generation, 0);
    assert.equal((await t.messages("Sent")).body.items.length, 0);
    assert.equal(await (await t.h.bucket("INBOX")).head(row.raw_key), null);
  } finally { await t.close(); }
});
