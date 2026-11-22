import assert from "node:assert/strict";
import { test } from "node:test";
import { normalReplyFixture } from "./normal-reply-fixture.mjs";
import { mailInput } from "./normal-send-fixture.mjs";

test("ordinary reply preview derives safe target from verified raw mail, then SMTP emits server-owned thread headers once", async () => {
  const t = await normalReplyFixture();
  try {
    await t.configure(); const original = await t.seed();
    const preview = await t.h.request(`${original.path}/reply`, { cookie: t.alice.cookie });
    assert.equal(preview.status, 200, preview.text); assert.equal(preview.body.reply.to, "support@example.test");
    assert.equal(preview.body.reply.subject, "Re: Reply acceptance"); assert.equal(preview.body.reply.threading, "available"); assert.equal(t.opens.length, 0);
    const input = { ...mailInput, to: preview.body.reply.to, replyToMessageId: original.id }, key = crypto.randomUUID();
    const sent = await t.send(input, key); assert.equal(sent.status, 201, sent.text);
    assert.equal(sent.body.outgoing.replyToMessageId, original.id);
    assert.match(t.messages[0], /\r\nIn-Reply-To: <original@example\.test>\r\n/);
    assert.match(t.messages[0], /\r\nReferences: <root@example\.test>\r\n <original@example\.test>\r\n/);
    await t.h.restart(); assert.equal((await t.send(input, key)).status, 200); assert.equal(t.messages.length, 1);
    assert.equal((await t.send({ ...input, replyToMessageId: crypto.randomUUID() }, key)).body.error.code, "idempotency_conflict");
  } finally { await t.close(); }
});

test("ordinary reply draft preserves its separate source, hash and atomic consumed state across save/reopen/send", async () => {
  const t = await normalReplyFixture();
  try {
    await t.configure(); const original = await t.seed(), id = crypto.randomUUID(), route = `${t.path}/drafts/${id}`;
    const { expectedRevision, smtpRevision, ...content } = mailInput;
    const save = await t.h.request(route, { cookie: t.alice.cookie, method: "PUT", body: { ...content, expectedRevision: 0, accountRevision: 1, replyToMessageId: original.id } });
    assert.equal(save.status, 201, save.text); assert.equal(save.body.draft.replyToMessageId, original.id);
    const row = await t.h.db.prepare("SELECT reply_message_id,normal_reply_message_id FROM drafts WHERE id=?").bind(id).first();
    assert.deepEqual(row, { reply_message_id: null, normal_reply_message_id: original.id });
    assert.equal((await t.send({ ...mailInput, draftId: id, draftRevision: 1 })).body.error.code, "draft_changed");
    const sent = await t.send({ ...mailInput, replyToMessageId: original.id, draftId: id, draftRevision: 1 }); assert.equal(sent.status, 201, sent.text);
    const read = await t.h.request(route, { cookie: t.alice.cookie }); assert.equal(read.body.draft.state, "submitted"); assert.equal(read.body.draft.revision, 2);
    assert.equal((await t.h.request(route, { cookie: t.alice.cookie, method: "DELETE", body: { expectedRevision: 2 } })).status, 200);
    assert.equal(await t.h.db.prepare("SELECT normal_reply_message_id FROM drafts WHERE id=?").bind(id).first("normal_reply_message_id"), null);
  } finally { await t.close(); }
});
