import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { createHarness } from "./runtime-harness.mjs";

test("33-to-34 additive columns preserve old drafts, replies, send guards and attachment resources", async () => {
  const h = await createHarness({}, false, "0033_normal_reply.sql");
  try {
    const alice = await h.register("normal-attachments-upgrade"), account = crypto.randomUUID(), normal = crypto.randomUUID(), temporary = crypto.randomUUID();
    const hash = createHash("sha256").update(JSON.stringify(["normal-draft-v1", account, 1, "to@test.example", [], [], "old", "text", "normal-reply-v1", "old-source"])).digest("hex");
    await h.db.prepare(`INSERT INTO normal_accounts(id,user_id,email_address,display_name,endpoint_id,endpoint_hash,username,enabled,revision,created_at,updated_at)
      VALUES (?,?,'old@example.test','old','example','hash','old',0,1,1,1)`).bind(account, alice.id).run();
    await h.db.prepare(`INSERT INTO drafts(user_id,id,revision,to_address,subject,text_body,content_hash,normal_account_id,normal_account_revision,normal_reply_message_id,created_at,updated_at)
      VALUES (?,?,1,'to@test.example','old','text',?,?,1,'old-source',1,1)`).bind(alice.id, normal, hash, account).run();
    await h.db.prepare(`INSERT INTO drafts(user_id,id,revision,subject,text_body,content_hash,attachments_json,created_at,updated_at)
      VALUES (?,?,1,'temp','temp bytes','old-temp-hash','[{"id":"old-asset","version":"old-version"}]',1,1)`).bind(alice.id, temporary).run();
    await h.db.prepare(`INSERT INTO normal_outgoing_messages(id,user_id,account_id,account_revision,smtp_revision,endpoint_hash,request_key,request_hash,from_address,to_address,recipient_count,subject,text_body,state,created_at,updated_at,reply_message_id,reply_threading)
      VALUES (?,?,?,1,1,'hash','old-request-key-1234','old-hash','old@example.test','to@test.example',1,'old','text','unknown',1,1,'old-source','submitted')`).bind(crypto.randomUUID(), alice.id, account).run();
    const tables = ["users", "sessions", "normal_accounts", "normal_smtp_configs", "normal_inbox_state", "normal_inbox_messages", "outbox_assets", "drafts", "normal_outgoing_messages", "send_recipient_charges"];
    const before = {}; for (const table of tables) before[table] = (await h.db.prepare(`SELECT * FROM ${table}`).all()).results;
    await h.migrate("0037_normal_sync_capacity.sql"); await h.migrate("0037_normal_sync_capacity.sql"); await h.restart();
    for (const table of tables) {
      let after = (await h.db.prepare(`SELECT * FROM ${table}`).all()).results;
      if (table === "drafts") after = after.map(({ normal_attachments_json, ...row }) => { assert.equal(normal_attachments_json, null); return row; });
      if (table === "normal_outgoing_messages") after = after.map(({ attachments_json, ...row }) => { assert.equal(attachments_json, null); return row; });
      assert.deepEqual(after, before[table], table);
    }
    for (const value of ["{}", "null", '"text"', "invalid"]) await assert.rejects(h.db.prepare("UPDATE drafts SET normal_attachments_json=? WHERE id=?").bind(value, normal).run());
    await assert.rejects(h.db.prepare("UPDATE drafts SET normal_attachments_json='[]' WHERE id=?").bind(temporary).run(), /CHECK/);
    await assert.rejects(h.db.prepare("UPDATE drafts SET attachments_json='[]' WHERE id=?").bind(normal).run(), /CHECK/);
    await assert.rejects(h.db.prepare("UPDATE normal_outgoing_messages SET attachments_json='{}'").run(), /CHECK/);
    const read = await h.request(`/api/v1/normal-accounts/${account}/drafts/${normal}`, { cookie: alice.cookie });
    assert.equal(read.body.draft.replyToMessageId, "old-source"); assert.deepEqual(read.body.draft.attachments, []);
    assert.deepEqual((await h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await h.close(); }
});
