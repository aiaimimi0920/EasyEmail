import assert from "node:assert/strict";
import { test } from "node:test";
import { normalRetentionFixture } from "./normal-retention-fixture.mjs";

test("ordinary content maintenance is capped at 100 and original-key replay never consumes another page; object cleanup is independently bounded", async () => {
  const t = await normalRetentionFixture({ testEntry: "./normal-retention-test-worker.ts" }), { h } = t;
  try {
    const { rows: [source] } = await t.receive();
    const statements = [];
    for (let i = 0; i < 105; i++) {
      const batch = crypto.randomUUID(), id = crypto.randomUUID(), uid = 100 + i, prefix = `normal-inbox/v1/${t.alice.id}/${t.id}/${batch}/${uid}`;
      const raw = `${prefix}.eml`, content = `${prefix}.json`;
      const manifest = JSON.stringify({ items: [{ id, uid, rawKey: raw, contentKey: content, rawBytes: source.raw_bytes, contentBytes: source.content_bytes }], skipped: [] });
      statements.push(h.db.prepare(`INSERT INTO normal_inbox_batches(id,account_id,account_revision,source_hash,from_version,epoch_id,uid_validity,after_uid,reset,complete,item_count,storage_bytes,manifest,status,created_at,committed_at)
        SELECT ?,account_id,account_revision,source_hash,from_version,epoch_id,uid_validity,?,0,1,1,?,?,status,created_at,committed_at FROM normal_inbox_batches WHERE id=?`)
        .bind(batch, uid, source.raw_bytes + source.content_bytes, manifest, source.batch_id));
      statements.push(h.db.prepare(`INSERT INTO normal_inbox_messages(id,account_id,batch_id,epoch_id,uid_validity,uid,raw_key,content_key,raw_sha256,content_sha256,raw_bytes,content_bytes,received_at,flags,observed_at)
        SELECT ?,account_id,?,epoch_id,uid_validity,?,?,?,raw_sha256,content_sha256,raw_bytes,content_bytes,received_at,flags,unixepoch()-259200 FROM normal_inbox_messages WHERE id=?`)
        .bind(id, batch, uid, raw, content, source.id));
    }
    await h.db.batch(statements); await t.policy({ enabled: true, cacheDays: 1 });
    const preview = (await t.preview()).body.preview;
    assert.equal(preview.counts.purgedNormalMessages, 100); assert.equal(preview.more.purgedNormalMessages, true);
    const key = crypto.randomUUID(), first = await t.run(key); assert.equal(first.status, 200, first.text);
    assert.equal(first.body.run.counts.purgedNormalMessages, 100);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_messages WHERE purged_at IS NOT NULL").first("n"), 100);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_object_deletions WHERE cleaned_at IS NOT NULL").first("n"), 20);
    assert.equal((await t.run(key)).body.replayed, true);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_object_deletions WHERE cleaned_at IS NOT NULL").first("n"), 20);
    const next = await t.run(); assert.equal(next.body.run.counts.purgedNormalMessages, 5);
    const cleaned = await h.request("/__test/normal-cleanup"); assert.equal(cleaned.status, 200, cleaned.text);
    assert.equal(cleaned.body.processed, 20); assert.ok(cleaned.body.inventoryCleaned <= 20);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_messages WHERE purged_at IS NOT NULL").first("n"), 105);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_messages WHERE purged_at IS NULL").first("n"), 2);
  } finally { await t.close(); }
});

test("incomplete retired staging reservations never fabricate byte releases or prune request guards", async () => {
  const t = await normalRetentionFixture(), { h } = t;
  try {
    const received = await t.receive();
    await h.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<11)
      INSERT INTO normal_inbox_batches(id,account_id,account_revision,source_hash,from_version,epoch_id,uid_validity,after_uid,reset,complete,item_count,storage_bytes,manifest,status,created_at)
      SELECT 'capacity-'||n.i,b.account_id,b.account_revision,b.source_hash,b.from_version,b.epoch_id,b.uid_validity,b.after_uid,
      0,0,0,12582912,'{"items":[],"skipped":[]}','staged',unixepoch()-86401 FROM n JOIN normal_inbox_batches b WHERE b.id=?`)
      .bind(received.result.result.batchId).run();
    const key = crypto.randomUUID(), blocked = await h.request(`${t.root}/sync`, { cookie: t.alice.cookie, method: "POST", headers: { "idempotency-key": key }, body: { expectedRevision: 1 } });
    assert.equal(blocked.status, 409, blocked.text);
    const result = await t.run(); assert.equal(result.status, 200, result.text); assert.equal(result.body.run.counts.retiredNormalBatches, 11);
    // Corrupt/legacy reservations with no tracked objects cannot prove a byte release.
    assert.equal(await h.db.prepare("SELECT SUM(released_bytes) n FROM normal_inbox_batches WHERE retired_at IS NOT NULL").first("n"), 0);
    assert.equal((await h.request(`${t.root}/sync`, { cookie: t.alice.cookie, method: "POST", headers: { "idempotency-key": key }, body: { expectedRevision: 1 } })).status, 409);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_requests").first("n"), 1);
  } finally { await t.close(); }
});

test("valid abandoned reservations reclaim byte capacity only through tracked object acknowledgements and allow a new sync", async () => {
  const t = await normalRetentionFixture(), { h } = t;
  try {
    const received = await t.receive();
    for (let i = 0; i < 11; i++) {
      const batch = crypto.randomUUID(), prefix = `normal-inbox/v1/${t.alice.id}/${t.id}/${batch}/`;
      const manifest = JSON.stringify({ items: [1, 2, 3].map(uid => ({ id: crypto.randomUUID(), uid, rawKey: `${prefix}${uid}.eml`, contentKey: `${prefix}${uid}.json`, rawBytes: 2097152, contentBytes: 2097152 })), skipped: [] });
      await h.db.prepare(`INSERT INTO normal_inbox_batches(id,account_id,account_revision,source_hash,from_version,epoch_id,uid_validity,after_uid,reset,complete,item_count,storage_bytes,manifest,status,created_at)
        SELECT ?,account_id,account_revision,source_hash,from_version,epoch_id,uid_validity,after_uid,0,0,3,12582912,?,'staged',unixepoch()-86401 FROM normal_inbox_batches WHERE id=?`)
        .bind(batch, manifest, received.result.result.batchId).run();
    }
    const key = crypto.randomUUID(), sync = () => h.request(`${t.root}/sync`, { cookie: t.alice.cookie, method: "POST", headers: { "idempotency-key": key }, body: { expectedRevision: 1 } });
    assert.equal((await sync()).status, 409);
    const run = await t.run(); assert.equal(run.status, 200, run.text); assert.equal(run.body.run.counts.retiredNormalBatches, 11);
    assert.equal(await h.db.prepare("SELECT SUM(released_bytes) n FROM normal_inbox_batches WHERE retired_at IS NOT NULL").first("n"), 20 * 2097152);
    const next = await sync(); assert.equal(next.status, 200, next.text); assert.equal(next.body.request.state, "committed");
    assert.equal(next.body.request.result.stored, 0); assert.equal((await t.state()).after_uid, 7);
    const original = await h.request(`${t.root}/sync-requests/${received.key}`, { cookie: t.alice.cookie }); assert.deepEqual(original.body.request, received.result);
  } finally { await t.close(); }
});
