import assert from "node:assert/strict";
import { test } from "node:test";
import { agentInboxFixture } from "./agent-inbox-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";

test("Agent failed writes retain capacity until journaled R2 acknowledgement; inventory also removes exact late puts, never unknown objects", async () => {
  const t = await agentInboxFixture();
  try {
    t.failOperation("/after-put"); const key = crypto.randomUUID(); assert.equal(expect(await t.receive(key)).operation.state, "failed");
    const batch = await t.h.db.prepare("SELECT * FROM agent_inbox_batches").first(), manifest = JSON.parse(batch.manifest), objectKey = manifest.items[0].rawKey;
    const bucket = await t.h.bucket("INBOX"), bytes = new Uint8Array(await (await bucket.get(objectKey)).arrayBuffer());
    assert.equal((await bucket.list()).objects.length, 1);
    const unknown = `agent-inbox/v1/${t.alice.id}/${t.id}/unknown/1.eml`; await bucket.put(unknown, "must-preserve");
    t.failOperation("/after-put", false); t.failOperation("/delete"); await t.h.scheduled();
    assert.equal(await t.h.db.prepare("SELECT state FROM agent_inbox_batches WHERE id=?").bind(batch.id).first("state"), "retiring");
    assert.ok(await bucket.head(objectKey)); assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_inbox_object_deletions WHERE cleaned_at IS NULL").first("n"), 4);
    t.failOperation("/delete", false); t.failOperation("/after-delete"); await t.h.scheduled();
    assert.equal(await bucket.head(objectKey), null); assert.equal(await t.h.db.prepare("SELECT state FROM agent_inbox_batches WHERE id=?").bind(batch.id).first("state"), "retiring");
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_inbox_object_deletions WHERE cleaned_at IS NULL").first("n"), 4);
    t.failOperation("/after-delete", false); await t.h.scheduled();
    assert.equal(await bucket.head(objectKey), null); assert.equal(await t.h.db.prepare("SELECT state FROM agent_inbox_batches WHERE id=?").bind(batch.id).first("state"), "retired");
    await bucket.put(objectKey, bytes); await t.h.scheduled(); assert.equal(await bucket.head(objectKey), null); assert.ok(await bucket.head(unknown));
    assert.equal(expect(await t.receive(key)).operation.state, "failed"); assert.equal(t.opens.length, 1);
  } finally { await t.close(); }
});

test("retirement never deletes a live claim, and old epochs are tombstoned without touching current Agent or normal namespace", async () => {
  const t = await agentInboxFixture(), gate = t.holdPut(); let pending;
  try {
    pending = t.receive(); await gate.entered; await t.h.scheduled();
    assert.equal(await t.h.db.prepare("SELECT state FROM agent_inbox_batches").first("state"), "staged");
    gate.release(); assert.equal(expect(await pending).operation.state, "committed"); pending = null;
    const old = expect(await t.messages()).items[0], bucket = await t.h.bucket("INBOX"); await bucket.put("normal-inbox/v1/preserve.eml", "preserve-normal");
    t.scenario({ validity: "43" }); expect(await t.receive()); await t.h.scheduled();
    expect(await t.message(old.id), 404); assert.equal(expect(await t.messages()).items.length, 2);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_incoming_messages WHERE purged_at IS NOT NULL").first("n"), 2);
    assert.equal((await bucket.list({ prefix: "agent-inbox/v1/" })).objects.length, 4); assert.ok(await bucket.head("normal-inbox/v1/preserve.eml"));
  } finally { gate.release(); if (pending) await pending; await t.close(); }
});

test("Agent cacheDays uses observation time, preserves immutable request outcomes and leaves retention-disabled current mail intact", async () => {
  const t = await agentInboxFixture();
  try {
    const key = crypto.randomUUID(), receipt = expect(await t.receive(key)).operation, id = expect(await t.messages()).items[0].id;
    await t.h.db.prepare("UPDATE agent_inbox_batches SET committed_at=unixepoch()-172800 WHERE state='committed'").run();
    await t.h.db.prepare("UPDATE retention_policy SET enabled=0,cache_days=1 WHERE id=1").run(); await t.h.scheduled(); expect(await t.message(id));
    await t.h.db.prepare("UPDATE retention_policy SET enabled=1,cache_days=1 WHERE id=1").run(); await t.h.scheduled();
    expect(await t.message(id), 404); assert.equal(expect(await t.messages()).items.length, 0);
    assert.deepEqual(expect(await t.receipt(key)).operation, receipt); assert.equal((await (await t.h.bucket("INBOX")).list()).objects.length, 0);
  } finally { await t.close(); }
});

test("a forged retirement manifest cannot authorize a foreign object deletion or free capacity", async () => {
  const t = await agentInboxFixture();
  try {
    t.failOperation("/after-put"); expect(await t.receive()); const batch = await t.h.db.prepare("SELECT * FROM agent_inbox_batches").first();
    const manifest = JSON.parse(batch.manifest), foreign = "agent-inbox/v1/foreign/account/batch/2.eml", bucket = await t.h.bucket("INBOX");
    await bucket.put(foreign, "foreign-private"); manifest.items[0].rawKey = foreign;
    await t.h.db.prepare("UPDATE agent_inbox_batches SET manifest=? WHERE id=?").bind(JSON.stringify(manifest), batch.id).run();
    await t.h.scheduled(); assert.ok(await bucket.head(foreign));
    assert.equal(await t.h.db.prepare("SELECT state FROM agent_inbox_batches WHERE id=?").bind(batch.id).first("state"), "staged");
  } finally { await t.close(); }
});
