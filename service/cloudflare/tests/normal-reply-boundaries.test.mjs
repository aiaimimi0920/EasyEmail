import assert from "node:assert/strict";
import { test } from "node:test";
import { normalReplyFixture, replyRaw } from "./normal-reply-fixture.mjs";
import { mailInput } from "./normal-send-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";

test("ordinary reply requires explicit read authority and the current owned committed non-trash source", async () => {
  const t = await normalReplyFixture();
  try {
    await t.configure(); const source = await t.seed(), path = `${source.path}/reply`;
    for (const scopes of [["messages:read"], ["mail-accounts:read"], ["mail-accounts:send"]]) {
      const key = await newKey(t.h, t.alice.cookie, { scopes });
      assert.equal((await t.h.request(path, { token: key.token })).status, 403);
      assert.equal((await t.send({ ...mailInput, replyToMessageId: source.id }, crypto.randomUUID(), { cookie: null, token: key.token })).status, 403);
    }
    const writer = await newKey(t.h, t.alice.cookie, { scopes: ["mail-accounts:read", "drafts:write"] });
    assert.equal((await t.h.request(`${t.path}/drafts/${crypto.randomUUID()}`, { token: writer.token, origin: null, method: "PUT",
      body: { expectedRevision: 0, accountRevision: 1, to: mailInput.to, subject: "reply", text: "body", replyToMessageId: source.id } })).status, 403);
    const bob = await t.h.register("normal-reply-bob"); assert.equal((await t.h.request(path, { cookie: bob.cookie })).status, 404);
    assert.equal((await t.h.request(`/api/v1/normal-accounts/${crypto.randomUUID()}/messages/${source.id}/reply`, { cookie: t.alice.cookie })).status, 404);
    assert.equal((await t.h.request(`${source.path}/reply?unsafe=1`, { cookie: t.alice.cookie })).status, 400);
    assert.equal((await t.send({ ...mailInput, replyToMessageId: crypto.randomUUID() })).status, 404);
    await t.h.db.prepare("INSERT INTO normal_message_state(message_id,trashed_at) VALUES (?,1)").bind(source.id).run();
    assert.equal((await t.h.request(path, { cookie: t.alice.cookie })).body.error.code, "invalid_reply_source");
    await t.h.db.prepare("UPDATE normal_message_state SET trashed_at=NULL WHERE message_id=?").bind(source.id).run();
    await t.h.db.prepare("UPDATE normal_inbox_batches SET status='staged',committed_at=NULL WHERE account_id=?").bind(t.id).run();
    assert.equal((await t.h.request(path, { cookie: t.alice.cookie })).status, 404);
    await t.h.db.prepare("UPDATE normal_inbox_batches SET status='committed',committed_at=1 WHERE account_id=?").bind(t.id).run();
    await t.h.db.prepare("UPDATE normal_inbox_state SET after_uid=0 WHERE account_id=?").bind(t.id).run();
    assert.equal((await t.h.request(path, { cookie: t.alice.cookie })).body.error.code, "invalid_reply_source");
    await t.h.db.prepare("UPDATE normal_inbox_state SET after_uid=1,source_hash='old-source' WHERE account_id=?").bind(t.id).run();
    assert.equal((await t.h.request(path, { cookie: t.alice.cookie })).status, 404); assert.equal(t.opens.length, 0);
  } finally { await t.close(); }
});

test("reply target rejects ambiguous/malformed raw addresses and never trusts cached sender", async () => {
  const t = await normalReplyFixture();
  try {
    for (const raw of [replyRaw("Reply-To: a@example.test, b@example.test"), replyRaw("Reply-To: a@example.test\r\nReply-To: b@example.test"),
      replyRaw("Reply-To: Team: a@example.test;"), replyRaw("Reply-To: bad@@example.test"), replyRaw("").replace("From: Sender <sender@example.test>", "From: a@example.test, b@example.test"),
      replyRaw("From: duplicate@example.test")]) {
      const source = await t.seed(raw), result = await t.h.request(`${source.path}/reply`, { cookie: t.alice.cookie });
      assert.equal(result.body.error?.code, "invalid_reply_source", result.text);
    }
    const source = await t.seed(replyRaw("")), result = await t.h.request(`${source.path}/reply`, { cookie: t.alice.cookie });
    assert.equal(result.body.reply.to, "sender@example.test"); assert.equal(result.body.reply.threading, "unavailable");
    const bucket = await t.h.bucket("INBOX"); await bucket.put(source.rawKey, "tampered raw body");
    assert.equal((await t.h.request(`${source.path}/reply`, { cookie: t.alice.cookie })).body.error.code, "normal_content_unavailable"); assert.equal(t.opens.length, 0);
  } finally { await t.close(); }
});

test("server threading falls back to a valid parent and rejects caller-owned MIME headers", async () => {
  const t = await normalReplyFixture();
  try {
    await t.configure(); const source = await t.seed(replyRaw("Message-ID: <own@example.test>\r\nIn-Reply-To: <parent@example.test>"));
    for (const extra of [{ inReplyTo: "<spoof@example.test>" }, { references: [] }, { threading: {} }])
      assert.equal((await t.send({ ...mailInput, replyToMessageId: source.id, ...extra })).status, 400);
    assert.equal((await t.send({ ...mailInput, replyToMessageId: source.id })).status, 201);
    assert.match(t.messages[0], /\r\nReferences: <parent@example\.test>\r\n <own@example\.test>\r\n/);
    const noId = await t.seed(replyRaw("Reply-To: support@example.test\r\nReferences: <unsafe@example.test>"));
    const sent = await t.send({ ...mailInput, replyToMessageId: noId.id }); assert.equal(sent.body.outgoing.threading, "unavailable");
    assert.doesNotMatch(t.messages[1], /\r\n(?:In-Reply-To|References):/);
  } finally { await t.close(); }
});
