import assert from "node:assert/strict";
import { test } from "node:test";
import { normalRetentionFixture } from "./normal-retention-fixture.mjs";

test("ordinary cache retention preserves identity, cursor and original sync receipt, removes content and reclaims tracked R2 objects", async () => {
  const t = await normalRetentionFixture(), { h, alice } = t;
  try {
    const received = await t.receive(), [old, fresh] = received.rows;
    assert.ok(old && fresh); await t.age(old.id);
    const before = await t.state(), bucket = await h.bucket("INBOX");
    await t.policy({ enabled: true, cacheDays: 1 });
    const preview = await t.preview(); assert.equal(preview.status, 200, preview.text);
    assert.equal(preview.body.preview.counts.purgedNormalMessages, 1);
    assert.ok(await bucket.head(old.raw_key));
    const key = crypto.randomUUID(), run = await t.run(key); assert.equal(run.status, 200, run.text);
    assert.equal(run.body.run.counts.purgedNormalMessages, 1);
    const tombstone = await h.db.prepare("SELECT * FROM normal_inbox_messages WHERE id=?").bind(old.id).first();
    assert.ok(tombstone.purged_at); assert.equal(tombstone.summary, null); assert.equal(tombstone.flags, "[]");
    for (const field of ["id", "batch_id", "uid", "epoch_id", "raw_sha256", "content_sha256"]) assert.equal(tombstone[field], old[field]);
    for (const table of ["normal_inbox_search", "normal_thread_links", "normal_message_subscriptions"]) {
      assert.equal((await h.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE message_id=?`).bind(old.id).first()).n, 0);
    }
    const after = await t.state();
    for (const field of ["version", "source_hash", "epoch_id", "uid_validity", "after_uid"]) assert.equal(after[field], before[field]);
    assert.equal(after.cache_generation, before.cache_generation + 1);
    assert.equal((await h.request(`${t.root}/messages/${old.id}`, { cookie: alice.cookie })).status, 404);
    const list = await h.request(`${t.root}/messages`, { cookie: alice.cookie });
    assert.equal(list.status, 200, list.text); assert.deepEqual(list.body.items.map(x => x.id), [fresh.id]);
    assert.equal(await bucket.head(old.raw_key), null); assert.equal(await bucket.head(old.content_key), null);
    assert.ok(await bucket.head(fresh.raw_key));
    const replay = await t.run(key); assert.equal(replay.body.replayed, true); assert.deepEqual(replay.body.run, run.body.run);
    const receipt = await h.request(`${t.root}/sync-requests/${received.key}`, { cookie: alice.cookie });
    assert.equal(receipt.status, 200, receipt.text); assert.deepEqual(receipt.body.request, received.result);
    assert.equal((await t.run()).body.run.counts.purgedNormalMessages, 0);
    const batch = await h.db.prepare("SELECT * FROM normal_inbox_batches WHERE id=?").bind(old.batch_id).first();
    assert.equal(batch.item_count, 2); assert.equal(batch.released_items, 1);
    assert.equal(batch.released_bytes, old.raw_bytes + old.content_bytes);
    assert.deepEqual(JSON.parse(batch.manifest).items.map(x => x.id), [fresh.id]);
    await h.restart(); assert.equal((await h.request(`${t.root}/messages/${old.id}`, { cookie: alice.cookie })).status, 404);
  } finally { await t.close(); }
});
