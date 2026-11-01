import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "./runtime-harness.mjs";
import { normalInput } from "./normal-imap-fixture.mjs";
import { seedLegacyNormalAccount } from "./normal-legacy-fixture.mjs";

test("0025 preserves old ordinary source identities and makes receipt links and summaries nullable", async () => {
  const h = await createHarness({ IMAP_ENDPOINTS: JSON.stringify([{ id: "example", label: "Test", hostname: "imap.example.test", port: 993 }]),
    MAILBOX_KEYRING: JSON.stringify({ active: "k1", keys: { k1: "c5".repeat(32) } }) }, false, "0024_normal_inbox.sql");
  try {
    const alice = await h.register("normal-access-expand"), accountId = crypto.randomUUID(), epoch = crypto.randomUUID(), batchId = crypto.randomUUID(), id = crypto.randomUUID();
    const item = { id, uid: 1, rawKey: "raw-key", contentKey: "content-key", rawSha256: "a".repeat(64),
      contentSha256: "b".repeat(64), rawBytes: 1, contentBytes: 1, receivedAt: 1, flags: [] };
    await seedLegacyNormalAccount(h, alice.id, accountId, normalInput);
    await h.db.prepare(`INSERT INTO normal_inbox_state(account_id,source_hash,epoch_id,uid_validity,after_uid,version)
      VALUES (?,'legacy',?,'42',1,1)`).bind(accountId, epoch).run();
    await h.db.prepare(`INSERT INTO normal_inbox_batches(id,account_id,account_revision,source_hash,from_version,epoch_id,uid_validity,
      after_uid,reset,complete,item_count,storage_bytes,manifest,status,created_at,committed_at)
      VALUES (?,?,1,'legacy',0,?,'42',1,0,1,1,2,?,'committed',1,1)`)
      .bind(batchId, accountId, epoch, JSON.stringify({ items: [item], skipped: [] })).run();
    await h.db.prepare(`INSERT INTO normal_inbox_messages(id,account_id,batch_id,epoch_id,uid_validity,uid,raw_key,content_key,
      raw_sha256,content_sha256,raw_bytes,content_bytes,received_at,flags,observed_at) VALUES (?,?,?,?,'42',1,'raw-key','content-key',?,?,1,1,1,'[]',1)`)
      .bind(id, accountId, batchId, epoch, item.rawSha256, item.contentSha256).run();
    const before = {};
    for (const table of ["normal_inbox_state", "normal_inbox_batches", "normal_inbox_messages"]) before[table] = await h.db.prepare(`SELECT * FROM ${table}`).first();
    await h.migrate("0025_normal_inbox_access.sql"); await h.migrate("0025_normal_inbox_access.sql");
    for (const [table, row] of Object.entries(before)) assert.deepEqual(await h.db.prepare(`SELECT * FROM ${table}`).first(),
      { ...row, [table === "normal_inbox_messages" ? "summary" : "request_id"]: null });
    assert.deepEqual((await h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_requests").first("n"), 0);
  } finally { await h.close(); }
});
