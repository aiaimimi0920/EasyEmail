import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "./runtime-harness.mjs";
import { normalInput } from "./normal-imap-fixture.mjs";
import { seedLegacyNormalAccount } from "./normal-legacy-fixture.mjs";

test("0030 expands ordinary subscriptions without altering old data/schema and enforces composite source ownership", async () => {
  const h = await createHarness({ IMAP_ENDPOINTS: JSON.stringify([{ id: "example", label: "Test", hostname: "imap.example.test", port: 993 }]),
    MAILBOX_KEYRING: JSON.stringify({ active: "k1", keys: { k1: "c5".repeat(32) } }) }, false, "0029_normal_conversations.sql");
  try {
    const alice = await h.register("normal-subscription-expand"), bob = await h.register("normal-subscription-foreign");
    const account = crypto.randomUUID(), epoch = crypto.randomUUID(), batch = crypto.randomUUID(), id = crypto.randomUUID();
    await seedLegacyNormalAccount(h, alice.id, account, normalInput);
    await h.db.prepare("INSERT INTO normal_inbox_state(account_id,source_hash,epoch_id,uid_validity,after_uid,version) VALUES (?,'legacy',?,'42',1,1)").bind(account, epoch).run();
    await h.db.prepare(`INSERT INTO normal_inbox_batches(id,account_id,account_revision,source_hash,from_version,epoch_id,uid_validity,after_uid,reset,complete,item_count,storage_bytes,manifest,status,created_at,committed_at)
      VALUES (?,?,1,'legacy',0,?,'42',1,0,1,1,2,'{}','committed',1,1)`).bind(batch, account, epoch).run();
    await h.db.prepare(`INSERT INTO normal_inbox_messages(id,account_id,batch_id,epoch_id,uid_validity,uid,raw_key,content_key,raw_sha256,content_sha256,raw_bytes,content_bytes,received_at,flags,observed_at)
      VALUES (?,?,?,?,'42',1,'raw','content',?,?,1,1,1,'[]',1)`).bind(id, account, batch, epoch, "a".repeat(64), "b".repeat(64)).run();
    const schema = (await h.db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all()).results;
    const before = {}; for (const { name } of schema) before[name] = (await h.db.prepare(`SELECT * FROM ${name}`).all()).results;
    await h.migrate("0030_normal_subscriptions.sql"); await h.migrate("0030_normal_subscriptions.sql");
    for (const { name, sql } of schema) {
      assert.deepEqual((await h.db.prepare(`SELECT * FROM ${name}`).all()).results, before[name]);
      assert.equal(await h.db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").bind(name).first("sql"), sql);
    }
    const insert = (user, accountId, epochId) => h.db.prepare("INSERT INTO normal_message_subscriptions VALUES (?,?,?,?,NULL,'','','','[]',0,0)").bind(user, accountId, epochId, id).run();
    await assert.rejects(insert(bob.id, account, epoch), /FOREIGN KEY/); await assert.rejects(insert(alice.id, account, crypto.randomUUID()), /FOREIGN KEY/);
    await insert(alice.id, account, epoch); await assert.rejects(insert(alice.id, account, epoch), /UNIQUE/);
    await assert.rejects(h.db.prepare("INSERT INTO normal_subscription_preferences VALUES (?,?,?, ?,0,1,1)").bind(bob.id, account, epoch, "f".repeat(64)).run(), /FOREIGN KEY/);
    assert.deepEqual((await h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
    assert.ok((await h.db.prepare("PRAGMA index_list(normal_message_subscriptions)").all()).results.some(row => row.name === "normal_subscriptions_group"));
  } finally { await h.close(); }
});
