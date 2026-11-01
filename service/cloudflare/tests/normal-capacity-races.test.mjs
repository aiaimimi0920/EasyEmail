import assert from "node:assert/strict";
import { test } from "node:test";
import { normalAccessFixture } from "./normal-access-fixture.mjs";
import { syncRows } from "./normal-capacity-fixture.mjs";

test("simultaneous first use of the same key creates one guard and at most one connection", async () => {
  const t = await normalAccessFixture(), key = crypto.randomUUID();
  try {
    const responses = await Promise.all(Array.from({ length: 12 }, () => t.receive(key)));
    for (const r of responses) assert.ok([200, 429].includes(r.status), r.text);
    assert.equal(new Set(responses.filter(r => r.status === 200).map(r => r.body.request.id)).size, 1);
    assert.equal((await syncRows(t.h)).length, 1); assert.equal(t.opens.length, 1);
    const final = await t.receipt(key); assert.equal(final.body.request.state, "committed");
    assert.deepEqual((await t.receive(key)).body, final.body);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_batches").first("n"), 1);
  } finally { await t.close(); }
});

test("lost successful request INSERT response reconciles its guard and never guesses that it may open a socket", async () => {
  const t = await normalAccessFixture({ testEntry: "./normal-capacity-test-worker.ts" }), key = crypto.randomUUID();
  try {
    const result = await t.receive(key, 1, { headers: { "idempotency-key": key, "x-test-request-insert-lost": "1" } });
    assert.equal(result.status, 200, result.text); assert.equal(result.body.request.state, "pending");
    assert.equal((await syncRows(t.h)).length, 1); assert.equal(t.opens.length, 0);
    await t.h.restart(); assert.deepEqual((await t.receive(key)).body, result.body); assert.equal(t.opens.length, 0);
    await t.h.db.prepare("UPDATE normal_inbox_requests SET created_at=unixepoch()-100 WHERE request_key=?").bind(key).run();
    const failed = await t.receive(key); assert.equal(failed.body.request.state, "failed");
    assert.equal(failed.body.request.errorCode, "normal_sync_interrupted"); assert.equal(t.opens.length, 0);
    assert.equal((await t.receive()).body.request.state, "committed"); assert.equal(t.opens.length, 1);
  } finally { await t.close(); }
});

for (const limit of ["items", "bytes"]) test(`staging checks actual ${limit} atomically after preflight without advancing the cursor`, async () => {
  const t = await normalAccessFixture(), key = crypto.randomUUID();
  try {
    const original = await t.receive(); assert.equal(original.body.request.state, "committed");
    const batch = await t.h.db.prepare("SELECT * FROM normal_inbox_batches WHERE id=?").bind(original.body.request.result.batchId).first();
    const count = limit === "items" ? 333 : 11, itemTotal = limit === "items" ? 997 : 0;
    const byteTotal = limit === "bytes" ? 134217727 - batch.storage_bytes : 0;
    await t.h.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
      INSERT INTO normal_inbox_batches(id,account_id,account_revision,source_hash,from_version,epoch_id,uid_validity,after_uid,
        reset,complete,item_count,storage_bytes,manifest,status,created_at)
      SELECT 'near-limit-'||i,b.account_id,1,b.source_hash,b.from_version,b.epoch_id,b.uid_validity,b.after_uid,0,0,
        MIN(3,MAX(0,?-(i-1)*3)),MIN(12582912,MAX(0,?-(i-1)*12582912)),
        '{"items":[],"skipped":[]}','staged',unixepoch() FROM n JOIN normal_inbox_batches b WHERE b.id=?`)
      .bind(count, itemTotal, byteTotal, batch.id).run();
    const before = await t.state(); t.scenario({ validity: "43" });
    const failed = await t.receive(key); assert.equal(failed.status, 200, failed.text);
    assert.equal(failed.body.request.state, "failed"); assert.equal(failed.body.request.errorCode, "normal_inbox_changed_or_limit");
    assert.equal((await t.state()).version, before.version); assert.equal((await t.state()).after_uid, before.after_uid);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_batches").first("n"), count + 1);
    assert.equal(t.opens.length, 2); assert.deepEqual((await t.receive(key)).body, failed.body); assert.equal(t.opens.length, 2);
  } finally { await t.close(); }
});
