import assert from "node:assert/strict";
import { test } from "node:test";
import { normalRetentionFixture } from "./normal-retention-fixture.mjs";
const options = { testEntry: "./normal-retention-test-worker.ts" };

test("D1 cleanup failure rolls back content and intents; a lost committed response reconciles the same guard without another batch", async () => {
  const t = await normalRetentionFixture(options);
  try {
    const { rows: [source] } = await t.receive(); await t.age(source.id); await t.policy({ enabled: true, cacheDays: 1 });
    const key = crypto.randomUUID(), header = name => ({ "idempotency-key": key, [name]: "1" });
    const failed = await t.run(key, { headers: header("x-test-retention-rollback") }); assert.equal(failed.status, 503, failed.text);
    assert.equal((await t.h.db.prepare("SELECT purged_at FROM normal_inbox_messages WHERE id=?").bind(source.id).first()).purged_at, null);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_object_deletions").first("n"), 0);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM retention_runs").first("n"), 0);
    const lost = await t.run(key, { headers: header("x-test-retention-lost") }); assert.equal(lost.status, 503, lost.text);
    const replay = await t.run(key); assert.equal(replay.status, 200, replay.text); assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.run.counts.purgedNormalMessages, 1); assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM retention_runs").first("n"), 1);
    await t.h.request("/__test/normal-cleanup"); assert.equal(await (await t.h.bucket("INBOX")).head(source.raw_key), null);
  } finally { await t.close(); }
});

test("R2 deletion failure does not undo tombstones and remains retryable after restart even with retention disabled", async () => {
  const t = await normalRetentionFixture(options);
  try {
    const { rows: [source] } = await t.receive(); await t.age(source.id); await t.policy({ enabled: true, cacheDays: 1 });
    const result = await t.run(crypto.randomUUID(), { headers: { "idempotency-key": crypto.randomUUID(), "x-test-retention-delete-fail": "1" } });
    assert.equal(result.status, 200, result.text); assert.equal(result.body.run.counts.purgedNormalMessages, 1);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_object_deletions WHERE cleaned_at IS NULL").first("n"), 2);
    assert.equal(await t.h.db.prepare("SELECT released_bytes FROM normal_inbox_batches WHERE id=?").bind(source.batch_id).first("released_bytes"), 0);
    assert.equal((await t.h.request(`${t.root}/messages/${source.id}`, { cookie: t.alice.cookie })).status, 404);
    assert.ok(await (await t.h.bucket("INBOX")).head(source.raw_key));
    await t.policy({ enabled: false }); await t.h.restart();
    const scheduled = await t.h.request("/__test/normal-scheduled-early-failure"); assert.equal(scheduled.body.failed, true);
    assert.equal(await (await t.h.bucket("INBOX")).head(source.raw_key), null);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_object_deletions WHERE cleaned_at IS NULL").first("n"), 0);
  } finally { await t.close(); }
});

for (const kind of ["detail", "raw", "search-index"]) test(`buffered ${kind} cannot expose or resurrect content after retention`, async () => {
  const t = await normalRetentionFixture(options); let pending, gate;
  try {
    const { rows: [source] } = await t.receive(); await t.age(source.id); await t.policy({ enabled: true, cacheDays: 1 });
    if (kind === "search-index") await t.h.db.prepare("DELETE FROM normal_inbox_search WHERE message_id=?").bind(source.id).run();
    gate = t.holdPut("/get");
    const route = kind === "search-index" ? `/api/v1/messages?sources=normal&accountId=${t.id}` : `${t.root}/messages/${source.id}${kind === "raw" ? "/raw" : ""}`;
    pending = fetch(new URL(route, t.h.baseUrl), { headers: { cookie: t.alice.cookie } }).then(async response => ({ status: response.status, text: await response.text() }));
    await gate.entered; assert.equal((await t.run()).body.run.counts.purgedNormalMessages, 1);
    gate.release(); const result = await pending; pending = null;
    assert.equal(result.status, 409, result.text); assert.equal(result.text.includes("742951"), false);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_search WHERE message_id=?").bind(source.id).first("n"), 0);
  } finally { gate?.release(); if (pending) await pending; await t.close(); }
});

test("abandoned staged intents retire only after grace and cannot commit; inventory reaps a late put but never unknown keys", async () => {
  const t = await normalRetentionFixture(options);
  try {
    t.failPut();
    const failed = await t.h.request(`${t.root}/sync`, { cookie: t.alice.cookie, method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: { expectedRevision: 1 } });
    assert.equal(failed.body.request.state, "failed");
    const batch = await t.h.db.prepare("SELECT * FROM normal_inbox_batches").first(), item = JSON.parse(batch.manifest).items[0];
    assert.equal((await t.preview()).body.preview.counts.retiredNormalBatches, 0);
    await t.h.db.prepare("UPDATE normal_inbox_batches SET created_at=unixepoch()-86401 WHERE id=?").bind(batch.id).run();
    const run = await t.run(); assert.equal(run.body.run.counts.retiredNormalBatches, 1);
    const row = await t.h.db.prepare("SELECT * FROM normal_inbox_batches WHERE id=?").bind(batch.id).first();
    assert.ok(row.retired_at); assert.equal(row.released_items, row.item_count); assert.equal(row.released_bytes, row.storage_bytes);
    const commit = await t.h.request("/__test/normal-commit", { cookie: t.alice.cookie, method: "POST", body: { batchId: batch.id } }); assert.equal(commit.status, 409, commit.text);
    const bucket = await t.h.bucket("INBOX"); await bucket.put(item.rawKey, "late bytes");
    const foreign = `normal-inbox/v1/${t.alice.id}/${t.id}/${crypto.randomUUID()}/1.eml`; await bucket.put(foreign, "not authorized by any deletion intent");
    await t.h.request("/__test/normal-cleanup"); assert.equal(await bucket.head(item.rawKey), null); assert.ok(await bucket.head(foreign));
    assert.equal((await t.state()).after_uid, 0); assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_messages").first("n"), 0);
  } finally { await t.close(); }
});
