import assert from "node:assert/strict";
import { test } from "node:test";
import { normalAccessFixture } from "./normal-access-fixture.mjs";
import { seedNormalSyncHistory, exhaustAdmission, syncRows } from "./normal-capacity-fixture.mjs";

test("more than 1000 released historical batches preserve exact receipt replay and allow a new receive across restart", async () => {
  const t = await normalAccessFixture(), originalKey = crypto.randomUUID();
  try {
    const original = await t.receive(originalKey); assert.equal(original.body.request.state, "committed", original.text);
    await seedNormalSyncHistory(t, original.body.request.result.batchId);
    const historical = await t.receipt("historical-sync-key-1005");
    assert.equal(historical.body.request.result.stored, 2);
    const rows = await syncRows(t.h), batches = (await t.h.db.prepare("SELECT * FROM normal_inbox_batches ORDER BY id").all()).results;
    await t.h.restart();
    const next = await t.receive(); assert.equal(next.status, 200, next.text); assert.equal(next.body.request.state, "committed");
    assert.equal(next.body.request.result.stored, 0); assert.equal(next.body.request.result.epochId, original.body.request.result.epochId);
    assert.deepEqual(next.body.request.result.cursor, original.body.request.result.cursor);
    assert.equal((await t.state()).version, 2); assert.equal(t.opens.length, 2);
    await exhaustAdmission(t.h, "normal-inbox-request", t.alice.id, 10);
    assert.deepEqual((await t.receive(originalKey)).body, original.body);
    assert.deepEqual((await t.receive("historical-sync-key-1005")).body, historical.body);
    assert.equal((await t.receive("historical-sync-key-1005", 2)).body.error.code, "idempotency_conflict");
    assert.equal(t.opens.length, 2);
    assert.deepEqual((await syncRows(t.h)).filter(r => rows.some(old => old.id === r.id)), rows);
    const kept = (await t.h.db.prepare("SELECT * FROM normal_inbox_batches ORDER BY id").all()).results;
    assert.deepEqual(kept.filter(r => batches.some(old => old.id === r.id)), batches);
    const list = await t.h.request(`${t.base}/sync-requests`, { cookie: t.alice.cookie });
    assert.equal(list.body.items.length, 20); assert.equal(list.body.items[0].id, next.body.request.id);
    const bob = await t.h.register("capacity-history-bob");
    assert.equal((await t.receipt("historical-sync-key-1005", { cookie: bob.cookie })).status, 404);
    assert.deepEqual((await t.h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await t.close(); }
});

test("retired zero-object intents no longer consume live-batch slots, but unretired abandoned intents still do", async () => {
  const t = await normalAccessFixture();
  try {
    const original = await t.receive(); assert.equal(original.body.request.state, "committed");
    await t.h.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1000)
      INSERT INTO normal_inbox_batches(id,account_id,account_revision,source_hash,from_version,epoch_id,uid_validity,after_uid,
        reset,complete,item_count,storage_bytes,manifest,status,created_at)
      SELECT 'empty-intent-'||i,b.account_id,1,b.source_hash,b.from_version,b.epoch_id,b.uid_validity,b.after_uid,
        0,1,0,0,'{"items":[],"skipped":[]}','staged',unixepoch()-86401 FROM n JOIN normal_inbox_batches b WHERE b.id=?`)
      .bind(original.body.request.result.batchId).run();
    assert.equal((await t.receive()).body.error.code, "normal_inbox_changed_or_limit"); assert.equal(t.opens.length, 1);
    await t.h.db.prepare("UPDATE normal_inbox_batches SET retired_at=unixepoch() WHERE id LIKE 'empty-intent-%'").run();
    const next = await t.receive(); assert.equal(next.status, 200, next.text); assert.equal(next.body.request.state, "committed");
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_batches WHERE retired_at IS NOT NULL").first("n"), 1000);
    assert.equal((await t.state()).version, 2); assert.equal(t.opens.length, 2);
  } finally { await t.close(); }
});
