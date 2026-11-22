import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "./runtime-harness.mjs";
import { normalInput } from "./normal-imap-fixture.mjs";
import { seedLegacyNormalAccount } from "./normal-legacy-fixture.mjs";

test("0026 only expands a derived projection table and preserves existing message, batch and cursor bytes", async () => {
  const h = await createHarness({ IMAP_ENDPOINTS: JSON.stringify([{ id: "example", label: "Test", hostname: "imap.example.test", port: 993 }]),
    MAILBOX_KEYRING: JSON.stringify({ active: "k1", keys: { k1: "c5".repeat(32) } }) }, false, "0025_normal_inbox_access.sql");
  try {
    const alice = await h.register("normal-unified-expand"), account = crypto.randomUUID(), epoch = crypto.randomUUID(), batch = crypto.randomUUID(), id = crypto.randomUUID();
    await seedLegacyNormalAccount(h, alice.id, account, normalInput);
    const item = { id, uid: 1, rawKey: "raw-key", contentKey: "content-key", rawSha256: "a".repeat(64),
      contentSha256: "b".repeat(64), rawBytes: 1, contentBytes: 1, receivedAt: 1, flags: [] };
    await h.db.prepare(`INSERT INTO normal_inbox_state(account_id,source_hash,epoch_id,uid_validity,after_uid,version)
      VALUES (?,'legacy',?,'42',1,1)`).bind(account, epoch).run();
    await h.db.prepare(`INSERT INTO normal_inbox_batches(id,account_id,account_revision,source_hash,from_version,epoch_id,uid_validity,
      after_uid,reset,complete,item_count,storage_bytes,manifest,status,created_at,committed_at)
      VALUES (?,?,1,'legacy',0,?,'42',1,0,1,1,2,?,'committed',1,1)`)
      .bind(batch, account, epoch, JSON.stringify({ items: [item], skipped: [] })).run();
    await h.db.prepare(`INSERT INTO normal_inbox_messages(id,account_id,batch_id,epoch_id,uid_validity,uid,raw_key,content_key,
      raw_sha256,content_sha256,raw_bytes,content_bytes,received_at,flags,observed_at) VALUES (?,?,?,?,'42',1,'raw-key','content-key',?,?,1,1,1,'[]',1)`)
      .bind(id, account, batch, epoch, item.rawSha256, item.contentSha256).run();
    const before = {};
    for (const table of ["normal_accounts", "normal_inbox_state", "normal_inbox_batches", "normal_inbox_messages", "normal_inbox_requests"]) {
      before[table] = (await h.db.prepare(`SELECT * FROM ${table}`).all()).results;
    }
    await h.migrate("0026_normal_inbox_search.sql"); await h.migrate("0026_normal_inbox_search.sql");
    for (const [table, rows] of Object.entries(before)) assert.deepEqual((await h.db.prepare(`SELECT * FROM ${table}`).all()).results, rows);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_search").first("n"), 0);
    await assert.rejects(h.db.prepare(`INSERT INTO normal_inbox_search VALUES (?,'hash','','','','','')`).bind(crypto.randomUUID()).run(), /FOREIGN KEY/);
    assert.deepEqual((await h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await h.close(); }
});
