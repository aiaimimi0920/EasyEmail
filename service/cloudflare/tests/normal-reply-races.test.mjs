import assert from "node:assert/strict";
import { test } from "node:test";
import { normalReplyFixture } from "./normal-reply-fixture.mjs";
import { mailInput } from "./normal-send-fixture.mjs";

async function draft(t, source) {
  const id = crypto.randomUUID(), path = `${t.path}/drafts/${id}`, body = { expectedRevision: 0, accountRevision: 1,
    to: mailInput.to, subject: mailInput.subject, text: mailInput.text, replyToMessageId: source.id };
  const saved = await t.h.request(path, { cookie: t.alice.cookie, method: "PUT", body }); assert.equal(saved.status, 201, saved.text);
  return { id, path, body, send: { ...mailInput, replyToMessageId: source.id, draftId: id, draftRevision: 1 } };
}
test("reply source mutations after raw verification cannot reserve SMTP or consume its cloud draft", async () => {
  for (const race of ["reply-epoch", "reply-source", "reply-uid", "reply-batch", "reply-hash", "reply-content", "reply-trash"]) {
    const t = await normalReplyFixture();
    try {
      await t.configure(); const source = await t.seed(), d = await draft(t, source), key = crypto.randomUUID();
      const response = await t.send(d.send, key, { headers: { "idempotency-key": key, "x-test-smtp-race": race } });
      assert.equal(response.body.error?.code, "normal_send_reservation_denied", `${race}: ${response.text}`);
      assert.equal(t.opens.length, 0); assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_outgoing_messages").first("n"), 0);
      assert.equal((await t.h.request(d.path, { cookie: t.alice.cookie })).body.draft.state, "editing");
    } finally { await t.close(); }
  }
});

test("reply save fences prevent new/editing drafts from persisting a changed original", async () => {
  for (const [race, create] of [["reply-epoch", true], ["reply-trash", false], ["reply-hash", false]]) {
    const t = await normalReplyFixture();
    try {
      const source = await t.seed(), d = await draft(t, source), path = create ? `${t.path}/drafts/${crypto.randomUUID()}` : d.path;
      const response = await t.h.request(path, { method: "PUT", cookie: t.alice.cookie, headers: { "x-test-smtp-race": race },
        body: { ...d.body, expectedRevision: create ? 0 : 1, text: "must not replace" } });
      assert.equal(response.status, 409, response.text);
      assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM drafts").first("n"), 1);
      assert.equal((await t.h.request(d.path, { cookie: t.alice.cookie })).body.draft.revision, 1);
    } finally { await t.close(); }
  }
});

test("reply original-key recovery precedes R2/source reads even after deletion; unknown consumes once and retention redacts references", async () => {
  const t = await normalReplyFixture(); let gate;
  try {
    await t.configure(); const source = await t.seed(), d = await draft(t, source), key = crypto.randomUUID(); gate = t.hold();
    const sending = t.send(d.send, key, { headers: { "idempotency-key": key, "x-test-smtp-finish-failure": "1" } }); await gate.entered;
    assert.equal((await t.send(d.send, key)).body.outgoing.state, "pending");
    assert.equal((await t.send(d.send)).body.error.code, "draft_submitted"); gate.release(); assert.equal((await sending).body.outgoing.state, "unknown");
    const bucket = await t.h.bucket("INBOX"); await bucket.delete(source.rawKey);
    await t.h.db.prepare("UPDATE normal_accounts SET deleted_at=1 WHERE id=?").bind(t.id).run();
    await t.h.db.prepare("UPDATE normal_outgoing_messages SET created_at=created_at-172800,updated_at=updated_at-172800").run();
    await t.h.db.prepare("UPDATE retention_policy SET enabled=1,outgoing_days=1,cache_days=0,trash_days=0,audit_days=0").run();
    await t.h.scheduled();
    assert.equal((await t.send(d.send, key)).body.outgoing.state, "unknown");
    await t.h.db.prepare("UPDATE normal_outgoing_messages SET updated_at=updated_at-172800").run();
    await t.h.scheduled(); await t.h.restart();
    const replay = await t.send(d.send, key); assert.equal(replay.body.outgoing.state, "unknown"); assert.equal("replyToMessageId" in replay.body.outgoing, false);
    const row = await t.h.db.prepare("SELECT reply_message_id,reply_threading,request_hash,recipient_count FROM normal_outgoing_messages").first();
    assert.equal(row.reply_message_id, null); assert.equal(row.reply_threading, null); assert.ok(row.request_hash); assert.equal(row.recipient_count, 1); assert.equal(t.opens.length, 1);
  } finally { gate?.release(); await t.close(); }
});
