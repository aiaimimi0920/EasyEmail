import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createHarness } from "./runtime-harness.mjs";

test("32-to-33 expands without changing old drafts/send guards and enforces reply source nullability", async () => {
  const h = await createHarness({}, false, "0032_normal_drafts.sql");
  try {
    const alice = await h.register("normal-reply-upgrade"), account = crypto.randomUUID(), draft = crypto.randomUUID(), key = crypto.randomUUID();
    const digest = createHash("sha256").update(JSON.stringify(["normal-draft-v1", account, 1, "to@example.test", [], [], "old", "正文"])).digest("hex");
    await h.db.prepare(`INSERT INTO normal_accounts(id,user_id,email_address,display_name,endpoint_id,endpoint_hash,username,enabled,revision,created_at,updated_at)
      VALUES (?,?,'old@example.test','old','example','hash','old',0,1,1,1)`).bind(account, alice.id).run();
    await h.db.prepare(`INSERT INTO drafts(user_id,id,revision,to_address,subject,text_body,content_hash,normal_account_id,normal_account_revision,created_at,updated_at)
      VALUES (?,?,1,'to@example.test','old','正文',?,?,1,1,1)`).bind(alice.id, draft, digest, account).run();
    await h.db.prepare(`INSERT INTO normal_outgoing_messages(id,user_id,account_id,account_revision,smtp_revision,endpoint_hash,request_key,request_hash,
      from_address,to_address,recipient_count,subject,text_body,state,created_at,updated_at)
      VALUES (?,?,?,1,1,'hash',?,'old-request-hash','old@example.test','to@example.test',1,'old','正文','unknown',1,1)`)
      .bind(crypto.randomUUID(), alice.id, account, key).run();
    const before = {}; for (const name of ["users", "sessions", "normal_accounts", "drafts", "normal_outgoing_messages"])
      before[name] = (await h.db.prepare(`SELECT * FROM ${name}`).all()).results;
    await h.migrate("0037_normal_sync_capacity.sql"); await h.migrate("0037_normal_sync_capacity.sql");
    for (const [name, rows] of Object.entries(before)) {
      let after = (await h.db.prepare(`SELECT * FROM ${name}`).all()).results;
      if (name === "drafts") after = after.map(({ normal_reply_message_id, normal_attachments_json, ...row }) => { assert.equal(normal_reply_message_id, null); assert.equal(normal_attachments_json, null); return row; });
      if (name === "normal_outgoing_messages") after = after.map(({ reply_message_id, reply_threading, attachments_json, ...row }) => {
        assert.equal(reply_message_id, null); assert.equal(reply_threading, null); assert.equal(attachments_json, null); return row;
      });
      assert.deepEqual(after, rows, name);
    }
    for (const [id, threading] of [["source", null], [null, "submitted"], ["source", "invalid"]]) await assert.rejects(
      h.db.prepare("UPDATE normal_outgoing_messages SET reply_message_id=?,reply_threading=?").bind(id, threading).run(), /CHECK/);
    await assert.rejects(h.db.prepare("UPDATE drafts SET normal_account_id=NULL,normal_account_revision=NULL,normal_reply_message_id='source' WHERE id=?").bind(draft).run(), /CHECK/);
    const read = await h.request(`/api/v1/normal-accounts/${account}/drafts/${draft}`, { cookie: alice.cookie });
    assert.equal(read.body.draft.replyToMessageId, null); assert.equal(read.body.draft.text, "正文");
    assert.deepEqual((await h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await h.close(); }
});
