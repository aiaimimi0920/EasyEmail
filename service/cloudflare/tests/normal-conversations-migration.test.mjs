import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "./runtime-harness.mjs";
import { normalInput } from "./normal-imap-fixture.mjs";
import { seedLegacyNormalAccount } from "./normal-legacy-fixture.mjs";

test("0029 additively indexes ordinary conversations with composite ownership and preserves all old receipt/source bytes", async () => {
  const h = await createHarness({ IMAP_ENDPOINTS: JSON.stringify([{ id: "example", label: "Test", hostname: "imap.example.test", port: 993 }]),
    MAILBOX_KEYRING: JSON.stringify({ active: "k1", keys: { k1: "c5".repeat(32) } }) }, false, "0028_normal_message_taxonomy.sql");
  try {
    const alice = await h.register("normal-conversation-expand"), bob = await h.register("normal-conversation-foreign");
    const account = crypto.randomUUID(), epoch = crypto.randomUUID(), batch = crypto.randomUUID(), id = crypto.randomUUID();
    await seedLegacyNormalAccount(h, alice.id, account, normalInput);
    await h.db.prepare("INSERT INTO normal_inbox_state(account_id,source_hash,epoch_id,uid_validity,after_uid,version) VALUES (?,'legacy',?,'42',1,1)").bind(account, epoch).run();
    await h.db.prepare(`INSERT INTO normal_inbox_batches(id,account_id,account_revision,source_hash,from_version,epoch_id,uid_validity,after_uid,reset,complete,item_count,storage_bytes,manifest,status,created_at,committed_at)
      VALUES (?,?,1,'legacy',0,?,'42',1,0,1,1,2,'{}','committed',1,1)`).bind(batch, account, epoch).run();
    await h.db.prepare(`INSERT INTO normal_inbox_messages(id,account_id,batch_id,epoch_id,uid_validity,uid,raw_key,content_key,raw_sha256,content_sha256,raw_bytes,content_bytes,received_at,flags,observed_at)
      VALUES (?,?,?,?,'42',1,'raw','content',?,?,1,1,1,'[]',1)`).bind(id, account, batch, epoch, "a".repeat(64), "b".repeat(64)).run();
    const tables = ["normal_accounts", "normal_inbox_state", "normal_inbox_batches", "normal_inbox_messages", "normal_inbox_requests", "normal_inbox_search", "normal_message_state", "normal_message_labels", "normal_message_folders"];
    const before = {}; for (const table of tables) before[table] = (await h.db.prepare(`SELECT * FROM ${table}`).all()).results;
    await h.migrate(); await h.migrate();
    for (const [table, rows] of Object.entries(before)) {
      const after = (await h.db.prepare(`SELECT * FROM ${table}`).all()).results; assert.equal(after.length, rows.length);
      for (const [i, row] of rows.entries()) assert.deepEqual(Object.fromEntries(Object.keys(row).map(key => [key, after[i][key]])), row);
    }
    const message = await h.db.prepare("SELECT thread_key,thread_basis,thread_version,thread_limited FROM normal_inbox_messages").first();
    assert.deepEqual(message, { thread_key: null, thread_basis: null, thread_version: 0, thread_limited: 0 });
    const insert = (user, accountId, epochId) => h.db.prepare("INSERT INTO normal_thread_links VALUES (?,?,?,?,?,?)").bind(user, accountId, epochId, id, "token", id).run();
    await assert.rejects(insert(bob.id, account, epoch), /FOREIGN KEY/);
    await assert.rejects(insert(alice.id, account, crypto.randomUUID()), /FOREIGN KEY/);
    await insert(alice.id, account, epoch); await assert.rejects(insert(alice.id, account, epoch), /UNIQUE/);
    assert.deepEqual((await h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
    assert.ok((await h.db.prepare("PRAGMA index_list(normal_thread_links)").all()).results.some(row => row.name === "normal_thread_links_token"));
  } finally { await h.close(); }
});
