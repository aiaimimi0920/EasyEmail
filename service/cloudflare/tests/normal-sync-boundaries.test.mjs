import assert from "node:assert/strict";
import { test } from "node:test";
import { normalSyncFixture } from "./normal-sync-fixture.mjs";
import { RAW_MESSAGE } from "./normal-read-fixture.mjs";
import { createHarness, seedMailbox } from "./runtime-harness.mjs";
import { normalInput } from "./normal-imap-fixture.mjs";
import { seedLegacyNormalAccount } from "./normal-legacy-fixture.mjs";

test("different owners may receive the same address without sharing a source identity or result", async () => {
  const t = await normalSyncFixture();
  try {
    const bob = await t.h.register("normal-sync-bob"), otherId = crypto.randomUUID();
    assert.equal((await t.save({}, 0, bob.cookie, otherId)).status, 201);
    assert.equal((await t.sync(1, { cookie: bob.cookie })).status, 404); assert.equal(t.opens.length, 0);
    const a = await t.sync(); assert.equal(a.status, 200, a.text);
    const b = await t.sync(1, { cookie: bob.cookie, body: { accountId: otherId, expectedRevision: 1 } }); assert.equal(b.status, 200, b.text);
    assert.notEqual(a.body.epochId, b.body.epochId);
    const rows = (await t.h.db.prepare("SELECT account_id,epoch_id,raw_key FROM normal_inbox_messages").all()).results;
    assert.equal(rows.length, 4); assert.equal(new Set(rows.map(row => row.raw_key)).size, 4);
    assert.equal((await t.h.request("/__test/normal-commit", { method: "POST", cookie: bob.cookie, body: { batchId: a.body.batchId } })).status, 404);
  } finally { await t.close(); }
});

test("empty UID windows and the three-message budget persist only the inspected checkpoint", async () => {
  const t = await normalSyncFixture({ messages: new Map([[205, RAW_MESSAGE], [206, RAW_MESSAGE], [207, RAW_MESSAGE], [208, RAW_MESSAGE]]), uidNext: 209 });
  try {
    for (const after of [100, 200, 207, 208]) {
      const result = await t.sync(); assert.equal(result.status, 200, result.text);
      assert.equal(result.body.cursor.afterUid, after); assert.equal(result.body.complete, after === 208);
    }
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_messages").first("n"), 4);
  } finally { await t.close(); }
});

test("staged objects cannot be published when uploads are incomplete", async () => {
  const t = await normalSyncFixture();
  try {
    t.failPut(); assert.equal((await t.sync()).status, 503);
    const batch = await t.h.db.prepare("SELECT id FROM normal_inbox_batches").first();
    const result = await t.h.request("/__test/normal-commit", { method: "POST", cookie: t.alice.cookie, body: { batchId: batch.id } });
    assert.equal(result.status, 503, result.text); assert.equal(result.body.error.code, "normal_inbox_storage_failed");
    assert.equal((await t.state()).version, 0); assert.equal((await t.state()).after_uid, 0);
  } finally { await t.close(); }
});

for (const limit of ["receipts", "items", "bytes"]) test(`live ${limit} bounds include abandoned intents and reject a new batch without moving its checkpoint`, async () => {
  const t = await normalSyncFixture();
  try {
    assert.equal((await t.sync()).status, 200);
    const count = limit === "receipts" ? 999 : limit === "items" ? 333 : 11;
    await t.h.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
      INSERT INTO normal_inbox_batches(id,account_id,account_revision,source_hash,from_version,epoch_id,uid_validity,after_uid,
        reset,complete,item_count,storage_bytes,manifest,status,created_at)
      SELECT 'abandoned-'||n.i,b.account_id,b.account_revision,b.source_hash,b.from_version,b.epoch_id,b.uid_validity,b.after_uid,
        0,0,?,?,'{"items":[],"skipped":[]}', 'staged',unixepoch() FROM n JOIN normal_inbox_batches b WHERE b.status='committed'`)
      .bind(count, limit === "items" ? 3 : 0, limit === "bytes" ? 12582912 : 0).run();
    const result = await t.sync(); assert.equal(result.status, 409, result.text); assert.equal(result.body.error.code, "normal_inbox_changed_or_limit");
    assert.equal((await t.state()).version, 1); assert.equal((await t.state()).after_uid, 7);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_batches").first("n"), count + 1);
  } finally { await t.close(); }
});

test("0024 is additive: old normal accounts, temporary mailbox constraints and old writers survive", async () => {
  const h = await createHarness({ IMAP_ENDPOINTS: JSON.stringify([{ id: "example", label: "Test", hostname: "imap.example.test", port: 993 }]),
    MAILBOX_KEYRING: JSON.stringify({ active: "k1", keys: { k1: "c5".repeat(32) } }) }, false, "0023_normal_accounts.sql");
  try {
    const alice = await h.register("normal-expand-alice"), id = crypto.randomUUID();
    await seedLegacyNormalAccount(h, alice.id, id, normalInput);
    const before = await h.db.prepare("SELECT * FROM normal_accounts WHERE id=?").bind(id).first();
    const mailbox = await seedMailbox(h, alice.id, "legacy-before@example.test");
    await h.migrate("0037_normal_sync_capacity.sql"); await h.migrate("0037_normal_sync_capacity.sql");
    assert.deepEqual(await h.db.prepare("SELECT * FROM normal_accounts WHERE id=?").bind(id).first(), before);
    assert.equal((await h.db.prepare("SELECT id FROM mailboxes WHERE id=?").bind(mailbox).first()).id, mailbox);
    await seedMailbox(h, alice.id, "legacy-after@example.test");
    await assert.rejects(seedMailbox(h, alice.id, "legacy-after@example.test"), /UNIQUE/);
    assert.deepEqual((await h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_state").first("n"), 0);
  } finally { await h.close(); }
});
