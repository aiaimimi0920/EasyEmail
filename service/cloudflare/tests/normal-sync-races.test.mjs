import assert from "node:assert/strict";
import { test } from "node:test";
import { normalSyncFixture } from "./normal-sync-fixture.mjs";

for (const change of ["disable", "remove", "inactive-user", "expired-lease", "replaced-token", "advanced-version"]) {
  test(`normal receive fences ${change} after staging and never publishes a stale checkpoint`, async () => {
    const t = await normalSyncFixture(), gate = t.holdPut(); let pending;
    try {
      pending = t.sync(); await gate.entered;
      const before = await t.state(); assert.ok(before.claim_token);
      if (change === "disable") assert.equal((await t.save({ enabled: false }, 1)).status, 200);
      if (change === "remove") assert.equal((await t.h.request(`/api/v1/normal-accounts/${t.id}`, { method: "DELETE", cookie: t.alice.cookie,
        headers: { "idempotency-key": crypto.randomUUID() }, body: { expectedRevision: 1 } })).status, 200);
      if (change === "inactive-user") await t.h.db.prepare("UPDATE users SET status='disabled' WHERE id=?").bind(t.alice.id).run();
      if (change === "expired-lease") await t.h.db.prepare("UPDATE normal_inbox_state SET claim_lease_until=unixepoch()-1 WHERE account_id=?").bind(t.id).run();
      if (change === "replaced-token") await t.h.db.prepare("UPDATE normal_inbox_state SET claim_token='new-owner-token' WHERE account_id=?").bind(t.id).run();
      if (change === "advanced-version") await t.h.db.prepare("UPDATE normal_inbox_state SET version=version+1 WHERE account_id=?").bind(t.id).run();
      gate.release(); const result = await pending; pending = null;
      assert.equal(result.status, 409, result.text); assert.equal(result.body.error.code, "normal_inbox_changed");
      const after = await t.state(); assert.equal(after.after_uid, 0);
      if (change === "replaced-token") assert.equal(after.claim_token, "new-owner-token", "old cleanup must not release another owner");
      assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_messages").first("n"), 0);
      assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_batches WHERE status='committed'").first("n"), 0);
    } finally { gate.release(); if (pending) await pending; await t.close(); }
  });
}

test("a newer account revision takes over a stale lease and the old worker cannot overwrite its epoch", async () => {
  const t = await normalSyncFixture(), gate = t.holdPut(); let pending;
  try {
    pending = t.sync(); await gate.entered;
    assert.equal((await t.sync()).body.error.code, "normal_inbox_busy_or_changed");
    assert.equal((await t.save({ username: "new-login" }, 1)).status, 200);
    const newer = await t.sync(2); assert.equal(newer.status, 200, newer.text);
    gate.release(); const old = await pending; pending = null;
    assert.equal(old.status, 409, old.text);
    assert.equal((await t.state()).epoch_id, newer.body.epochId); assert.equal((await t.state()).version, 1);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_messages").first("n"), 2);
  } finally { gate.release(); if (pending) await pending; await t.close(); }
});

test("a failed message insert rolls back both receipt publication and checkpoint advancement", async () => {
  const t = await normalSyncFixture(), gate = t.holdPut(); let pending;
  try {
    pending = t.sync(); await gate.entered;
    const batch = await t.h.db.prepare("SELECT * FROM normal_inbox_batches").first();
    const manifest = JSON.parse(batch.manifest); manifest.items[1].id = manifest.items[0].id;
    await t.h.db.prepare("UPDATE normal_inbox_batches SET manifest=? WHERE id=?").bind(JSON.stringify(manifest), batch.id).run();
    gate.release(); const failed = await pending; pending = null;
    assert.equal(failed.status, 503, failed.text); assert.equal(failed.body.error.code, "normal_inbox_storage_failed");
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_messages").first("n"), 0);
    assert.equal((await t.state()).after_uid, 0); assert.equal((await t.state()).version, 0);
    assert.equal((await t.h.db.prepare("SELECT status FROM normal_inbox_batches WHERE id=?").bind(batch.id).first()).status, "staged");
  } finally { gate.release(); if (pending) await pending; await t.close(); }
});

test("source identity survives display-name/password edits, but changing the remote account resets its epoch", async () => {
  const t = await normalSyncFixture();
  try {
    const initial = await t.sync(); assert.equal(initial.status, 200, initial.text);
    assert.equal((await t.save({ displayName: "new label", password: "Synthetic-rotated-app-password" }, 1)).status, 200);
    const same = await t.sync(2); assert.equal(same.status, 200, same.text); assert.equal(same.body.stored, 0); assert.equal(same.body.epochId, initial.body.epochId);
    assert.equal((await t.save({ username: "different-user" }, 2)).status, 200);
    const different = await t.sync(3); assert.equal(different.status, 200, different.text);
    assert.equal(different.body.reset, true); assert.equal(different.body.stored, 2); assert.notEqual(different.body.epochId, initial.body.epochId);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_messages").first("n"), 4);
  } finally { await t.close(); }
});

test("concurrent commits of the exact staged intent and the original worker publish just once", async () => {
  const t = await normalSyncFixture(), gate = t.holdPut("/head"); let pending;
  try {
    pending = t.sync(); await gate.entered;
    const batch = await t.h.db.prepare("SELECT id FROM normal_inbox_batches WHERE status='staged'").first();
    const repeated = await t.h.request("/__test/normal-commit", { method: "POST", cookie: t.alice.cookie,
      headers: { "x-test-parallel": "1" }, body: { batchId: batch.id } });
    assert.equal(repeated.status, 200, repeated.text);
    gate.release(); const original = await pending; pending = null;
    assert.equal(original.status, 200, original.text); assert.deepEqual(original.body, repeated.body);
    assert.equal((await t.state()).version, 1);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_messages").first("n"), 2);
  } finally { gate.release(); if (pending) await pending; await t.close(); }
});

test("a lost successful database response reconciles the original receipt without replaying uploads", async () => {
  const t = await normalSyncFixture();
  try {
    const result = await t.sync(1, { headers: { "x-test-lost-batch": "1" } }); assert.equal(result.status, 200, result.text);
    assert.equal((await t.state()).version, 1); assert.equal(result.body.stored, 2);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_batches").first("n"), 1);
    assert.equal((await (await t.h.bucket("INBOX")).list()).objects.length, 4);
  } finally { await t.close(); }
});
