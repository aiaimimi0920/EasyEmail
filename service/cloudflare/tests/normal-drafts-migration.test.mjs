import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "./runtime-harness.mjs";

test("31-to-32 additive draft sources preserve temporary content/hash/receipt and enforce disjoint source shapes", async () => {
  const h = await createHarness({}, false, "0031_normal_send.sql");
  try {
    const alice = await h.register("normal-draft-upgrade"), account = crypto.randomUUID(), draft = crypto.randomUUID();
    await h.db.prepare(`INSERT INTO normal_accounts(id,user_id,email_address,display_name,endpoint_id,endpoint_hash,username,enabled,revision,created_at,updated_at)
      VALUES (?,?,'old@example.test','old','example','hash','old',0,1,1,1)`).bind(account, alice.id).run();
    await h.db.prepare(`INSERT INTO drafts(user_id,id,revision,state,to_address,subject,text_body,content_hash,outgoing_id,created_at,updated_at)
      VALUES (?,?,2,'submitted','to@example.test','legacy draft','旧正文','legacy-hash','legacy-outgoing',1,2)`).bind(alice.id, draft).run();
    const before = await h.db.prepare("SELECT * FROM drafts").first(); await h.migrate(); await h.migrate();
    const { normal_account_id, normal_account_revision, normal_reply_message_id, normal_attachments_json, ...after } = await h.db.prepare("SELECT * FROM drafts").first();
    assert.deepEqual(after, before); assert.equal(normal_account_id, null); assert.equal(normal_account_revision, null); assert.equal(normal_reply_message_id, null); assert.equal(normal_attachments_json, null);
    const read = await h.request(`/api/v1/drafts/${draft}`, { cookie: alice.cookie }); assert.equal(read.status, 200, read.text);
    assert.equal(read.body.draft.outgoingId, "legacy-outgoing"); assert.equal("normalAccountId" in read.body.draft, false);
    for (const [id, revision, mailbox] of [[account, null, null], [account, 0, null], [null, 1, null], [account, 1, "not-temporary"]]) {
      await assert.rejects(h.db.prepare("UPDATE drafts SET normal_account_id=?,normal_account_revision=?,mailbox_id=? WHERE id=?")
        .bind(id, revision, mailbox, draft).run(), /CHECK/);
    }
    await assert.rejects(h.db.prepare("UPDATE drafts SET normal_account_id=?,normal_account_revision=1 WHERE id=?").bind(crypto.randomUUID(), draft).run(), /FOREIGN KEY/);
    assert.deepEqual((await h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
    assert.ok((await h.db.prepare("PRAGMA index_list('drafts')").all()).results.some(row => row.name === "drafts_normal_account_updated"));
  } finally { await h.close(); }
});
