import assert from "node:assert/strict";
import { before, after, beforeEach, test } from "node:test";
import { createHarness, newKey } from "./runtime-harness.mjs";
import { allocate } from "./provider-fixture.mjs";
import { sendFixture, sendRequest, sendCalls } from "./send-fixture.mjs";
import { draftBody, draftPath, saveDraft, deleteDraft, ok } from "./draft-fixture.mjs";

let f, h, alice, bob, box;
before(async () => {
  f = await sendFixture(); h = await createHarness(f.bindings);
  alice = await h.register("draft-send-alice"); bob = await h.register("draft-send-bob");
  const result = await allocate(h, alice.cookie); assert.equal(result.status, 201, result.text); box = result.body.mailbox;
}, { timeout: 90000 });
after(async () => { await h?.close(); await f?.close(); });
beforeEach(async () => { await h.resetLimits(); await h.db.prepare("UPDATE outgoing_messages SET created_at=unixepoch()-120").run(); });
async function sample() {
  const id = crypto.randomUUID(), body = draftBody(box.id);
  ok(await saveDraft(h, alice.cookie, id, body), 201);
  const { expectedRevision, mailboxId, ...content } = body;
  return { id, body, send: { ...content, replyToMessageId: undefined, draftId: id, draftRevision: 1 } };
}

test("submitting a saved draft consumes it with the outgoing reservation and replay never sends twice after restart", async () => {
  const d = await sample(), key = crypto.randomUUID(), before = sendCalls(f).length;
  let response = await sendRequest(h, alice.cookie, box, key, d.send); assert.equal(response.status, 201, response.text);
  const stored = ok(await h.request(draftPath(d.id), { cookie: alice.cookie }));
  assert.equal(stored.state, "submitted"); assert.equal(stored.revision, 2); assert.equal(stored.outgoingId, response.body.outgoing.id);
  await h.restart(); response = await sendRequest(h, alice.cookie, box, key, d.send);
  assert.equal(response.status, 200, response.text); assert.equal(sendCalls(f).length, before + 1);
  assert.equal((await sendRequest(h, alice.cookie, box, crypto.randomUUID(), d.send)).body.error.code, "draft_submitted");
  assert.equal((await saveDraft(h, alice.cookie, d.id, draftBody(box.id, { expectedRevision: 2 }))).status, 409);
  ok(await deleteDraft(h, alice.cookie, d.id, 2));
  assert.equal((await sendRequest(h, alice.cookie, box, key, d.send)).status, 200);
  assert.equal(sendCalls(f).length, before + 1);
});

test("concurrent fresh send keys for one draft have one dispatcher; editing and deletion fence stale send revisions", async () => {
  const d = await sample(), before = sendCalls(f).length;
  const results = await Promise.all([1, 2].map(() => sendRequest(h, alice.cookie, box, crypto.randomUUID(), d.send)));
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]); assert.equal(sendCalls(f).length, before + 1);
  const edited = await sample(); ok(await saveDraft(h, alice.cookie, edited.id, draftBody(box.id, { expectedRevision: 1, text: "newer" })));
  assert.equal((await sendRequest(h, alice.cookie, box, crypto.randomUUID(), edited.send)).status, 409);
  ok(await deleteDraft(h, alice.cookie, edited.id, 2));
  assert.equal((await sendRequest(h, alice.cookie, box, crypto.randomUUID(), edited.send)).status, 409);
  assert.equal(sendCalls(f).length, before + 1);
});

test("unknown provider outcome still consumes the draft and cannot be retried with a new key", async () => {
  const d = await sample(), before = sendCalls(f).length;
  f.modes.set("/cf/admin/send_mail_by_binding", "disconnect");
  try {
    const response = await sendRequest(h, alice.cookie, box, crypto.randomUUID(), d.send);
    assert.equal(response.status, 202, response.text); assert.equal(response.body.outgoing.state, "unknown");
    assert.equal((await sendRequest(h, alice.cookie, box, crypto.randomUUID(), d.send)).status, 409);
    assert.equal(ok(await h.request(draftPath(d.id), { cookie: alice.cookie })).state, "submitted");
    assert.equal(sendCalls(f).length, before + 1);
  } finally { f.modes.delete("/cf/admin/send_mail_by_binding"); }
});

test("draft commit failure rolls back the outgoing reservation before any provider dispatch", async () => {
  const d = await sample(), before = sendCalls(f).length;
  const count = await h.db.prepare("SELECT COUNT(*) n FROM outgoing_messages").first("n");
  await h.db.prepare("CREATE TRIGGER fail_draft_submit BEFORE UPDATE ON drafts WHEN NEW.state='submitted' BEGIN SELECT RAISE(ABORT,'synthetic commit failure'); END").run();
  try {
    assert.equal((await sendRequest(h, alice.cookie, box, crypto.randomUUID(), d.send)).status, 500);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM outgoing_messages").first("n"), count);
    assert.equal(ok(await h.request(draftPath(d.id), { cookie: alice.cookie })).state, "editing");
    assert.equal(sendCalls(f).length, before);
  } finally { await h.db.prepare("DROP TRIGGER fail_draft_submit").run(); }
});

test("sending requires saved content equality, both permissions and ownership; draft writes alone cannot send", async () => {
  const d = await sample(), before = sendCalls(f).length;
  for (const extra of [{ text: "unsaved edits" }, { draftRevision: 2 }, { draftId: crypto.randomUUID() }]) {
    assert.ok([404, 409].includes((await sendRequest(h, alice.cookie, box, crypto.randomUUID(), { ...d.send, ...extra })).status));
  }
  const sender = await newKey(h, alice.cookie, { scopes: ["messages:send"] });
  const writer = await newKey(h, alice.cookie, { scopes: ["drafts:write"] });
  for (const token of [sender.token, writer.token]) assert.equal((await sendRequest(h, null, box, crypto.randomUUID(), d.send, { token })).status, 403);
  assert.equal((await sendRequest(h, bob.cookie, box, crypto.randomUUID(), d.send)).status, 404);
  assert.equal(sendCalls(f).length, before);
  const both = await newKey(h, alice.cookie, { scopes: ["drafts:write", "messages:send"] });
  assert.equal((await sendRequest(h, null, box, crypto.randomUUID(), d.send, { token: both.token, origin: null })).status, 201);
});
