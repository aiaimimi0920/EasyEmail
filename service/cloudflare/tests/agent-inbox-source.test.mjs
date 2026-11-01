import assert from "node:assert/strict";
import { test } from "node:test";
import { agentInboxFixture } from "./agent-inbox-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";

async function fillCapacity(t, kind) {
  const batch = await t.h.db.prepare("SELECT * FROM agent_inbox_batches WHERE state='committed'").first();
  const sample = JSON.parse(batch.manifest).items[0], empty = kind === "batches";
  let remaining = empty ? 999 : kind === "items" ? 1000 - batch.item_count : 134217728 - batch.storage_bytes, index = 0, statements = [];
  while (remaining > 0) {
    const id = crypto.randomUUID(), requestId = crypto.randomUUID(), items = [];
    for (let uid = 1; !empty && uid <= 3 && remaining > 0; uid++) {
      const bytes = kind === "items" ? sample.rawBytes + sample.contentBytes : Math.min(4194304, remaining);
      const rawBytes = kind === "items" ? sample.rawBytes : Math.min(2097152, bytes - 1), contentBytes = bytes - rawBytes;
      const prefix = `agent-inbox/v1/${t.alice.id}/${t.id}/${id}/${uid}`;
      items.push({ ...sample, uid, rawKey: `${prefix}.eml`, contentKey: `${prefix}.json`, rawBytes, contentBytes });
      remaining -= kind === "items" ? 1 : bytes;
    }
    if (empty) remaining--;
    statements.push(t.h.db.prepare(`INSERT INTO agent_inbox_requests(id,user_id,account_id,request_key,account_revision,state,created_at)
      VALUES(?,?,?,?,1,'failed',unixepoch()-100)`).bind(requestId, t.alice.id, t.id, crypto.randomUUID()));
    // Empty successful history is no longer live capacity; abandoned staged intents still reserve slots.
    statements.push(t.h.db.prepare(`INSERT INTO agent_inbox_batches(id,user_id,account_id,request_id,source_hash,from_version,epoch_id,uid_validity,after_uid,state,item_count,storage_bytes,manifest,created_at,committed_at)
      VALUES(?,?,?,?,?,0,?,'42',7,?,?,?,?,unixepoch()+?,unixepoch())`).bind(id, t.alice.id, t.id, requestId, batch.source_hash, batch.epoch_id,
      empty ? "staged" : "committed", items.length, items.reduce((sum, row) => sum + row.rawBytes + row.contentBytes, 0), JSON.stringify({ items, skipped: [] }), ++index));
    if (statements.length === 100) { await t.h.db.batch(statements); statements = []; }
  }
  if (statements.length) await t.h.db.batch(statements);
  return batch;
}
for (const kind of ["batches", "items", "bytes"]) test(`source changes retire unreadable old cache even at exact full ${kind} capacity`, async () => {
  const t = await agentInboxFixture();
  try {
    await t.h.db.prepare("UPDATE retention_policy SET enabled=0,cache_days=0 WHERE id=1").run(); expect(await t.receive());
    const old = expect(await t.messages()).items[0], batch = await fillCapacity(t, kind);
    expect(await t.save({ username: "NewAlice" }, 1)); assert.equal(expect(await t.messages()).sourceReady, false);
    const state = await t.h.db.prepare("SELECT * FROM agent_inbox_state WHERE account_id=?").bind(t.id).first();
    assert.equal(state.epoch_id, null); assert.equal(state.source_hash, null); assert.equal(state.after_uid, 0);
    expect(await t.receive(undefined, 2), 409); assert.equal(t.opens.length, 1, "capacity cannot be bypassed before cleanup acknowledgement");
    await t.h.scheduled(); assert.equal(await t.h.db.prepare("SELECT state FROM agent_inbox_batches WHERE id=?").bind(batch.id).first("state"), "retired");
    expect(await t.message(old.id), 404); assert.equal(expect(await t.receive(undefined, 2)).operation.state, "committed");
    assert.equal(t.opens.length, 2); assert.equal(expect(await t.messages()).items.length, 2);
  } finally { await t.close(); }
});

test("display-name and password edits retain the same inbox epoch and do not retire current messages", async () => {
  const t = await agentInboxFixture();
  try {
    expect(await t.receive()); const page = expect(await t.messages());
    expect(await t.save({ displayName: "只改名称" }, 1)); await t.h.scheduled(); assert.equal(expect(await t.messages()).epochId, page.epochId);
    expect(await t.save({ displayName: "只改名称", password: "New-synthetic-password" }, 2)); await t.h.scheduled();
    assert.equal(expect(await t.messages()).epochId, page.epochId); expect(await t.message(page.items[0].id));
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_inbox_batches WHERE state='retired'").first("n"), 0);
  } finally { await t.close(); }
});
