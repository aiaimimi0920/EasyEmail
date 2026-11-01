import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { createHarness } from "./runtime-harness.mjs";
import { allocate } from "./provider-fixture.mjs";
import { sendFixture, sendBody, sendCalls, sendRequest } from "./send-fixture.mjs";
import { saveDraft, deleteDraft, draftBody } from "./draft-fixture.mjs";

let f, h, alice, bob, box;
const content = { ...sendBody, to: ["one@example.test"], cc: ["two@example.test"], bcc: ["private@example.test"] };
before(async () => {
  f = await sendFixture(); h = await createHarness(f.bindings);
  alice = await h.register("recipients-alice"); bob = await h.register("recipients-bob");
  box = (await allocate(h, alice.cookie)).body.mailbox;
});
beforeEach(async () => { await h.resetLimits(); await h.db.prepare("DELETE FROM outgoing_messages").run(); f.modes.clear(); });
after(async () => { try { await h?.close(); } finally { await f?.close(); } });

test("To/CC/BCC survive one binding dispatch, private history, restart and same-key replay", async () => {
  const key = crypto.randomUUID(), count = sendCalls(f).length;
  const result = await sendRequest(h, alice.cookie, box, key, content);
  assert.equal(result.status, 201, result.text);
  assert.deepEqual(sendCalls(f).at(-1).body, { from: box.address, to: content.to, cc: content.cc, bcc: content.bcc,
    subject: content.subject, text: content.text });
  assert.equal("headers" in sendCalls(f).at(-1).body, false, "BCC uses its dedicated envelope field, never a visible custom header");
  assert.deepEqual(result.body.outgoing.cc, content.cc); assert.deepEqual(result.body.outgoing.bcc, content.bcc);
  assert.equal((await h.request(`/api/v1/outgoing/${result.body.outgoing.id}`, { cookie: bob.cookie })).status, 404);
  assert.equal((await h.request("/api/v1/outgoing", { cookie: bob.cookie })).text.includes("private@example.test"), false);
  await h.restart();
  assert.equal((await sendRequest(h, alice.cookie, box, key, content)).body.outgoing.id, result.body.outgoing.id);
  for (const fields of [{ cc: ["changed@example.test"] }, { bcc: [] }, { to: ["changed@example.test"] }]) {
    assert.equal((await sendRequest(h, alice.cookie, box, key, { ...content, ...fields })).body.error.code, "idempotency_conflict");
  }
  assert.equal(sendCalls(f).length, count + 1);
});

test("old single-To hash is byte-compatible with empty CC/BCC and singleton arrays", async () => {
  const key = crypto.randomUUID(), result = await sendRequest(h, alice.cookie, box, key);
  const row = await h.db.prepare("SELECT * FROM outgoing_messages WHERE id=?").bind(result.body.outgoing.id).first();
  assert.equal(row.request_hash, createHash("sha256").update(JSON.stringify([box.id, sendBody.to, sendBody.subject, sendBody.text, null])).digest("hex"));
  assert.equal((await sendRequest(h, alice.cookie, box, key, { ...sendBody, to: [sendBody.to], cc: [], bcc: [] })).status, 200);
});

test("case-insensitive cross-list duplicates collapse To > CC > BCC, without hidden fan-out", async () => {
  const result = await sendRequest(h, alice.cookie, box, crypto.randomUUID(), { ...content,
    to: ["one@EXAMPLE.test", "ONE@example.test"], cc: ["ONE@example.test", "two@example.test"], bcc: ["TWO@example.test", "private@example.test"] });
  assert.equal(result.status, 201, result.text);
  assert.deepEqual(sendCalls(f).at(-1).body.to, ["one@example.test"]);
  assert.deepEqual(sendCalls(f).at(-1).body.cc, ["two@example.test"]);
  assert.deepEqual(sendCalls(f).at(-1).body.bcc, ["private@example.test"]);
  assert.equal((await h.db.prepare("SELECT recipient_count n FROM outgoing_messages").first()).n, 3);
});

test("multiple visible To addresses and empty optional lists use one structured request", async () => {
  const to = ["one@example.test", "two@example.test"];
  const result = await sendRequest(h, alice.cookie, box, crypto.randomUUID(), { ...sendBody, to });
  assert.equal(result.status, 201, result.text); assert.deepEqual(result.body.outgoing.to, to);
  assert.deepEqual(sendCalls(f).at(-1).body.to, to);
  assert.equal("cc" in sendCalls(f).at(-1).body, false);
});

test("recipient-weighted reservations preserve original budgets even for unknown outcomes", async () => {
  f.modes.set("/cf/admin/send_mail_by_binding", "disconnect");
  const count = sendCalls(f).length;
  const results = await Promise.all(Array.from({ length: 3 }, () => sendRequest(h, alice.cookie, box, crypto.randomUUID(), content)));
  assert.equal(results.filter(r => r.body.outgoing?.state === "unknown").length, 1);
  assert.equal(results.filter(r => r.body.error?.code === "send_quota_exceeded").length, 2);
  assert.equal(sendCalls(f).length, count + 1);
  const rejected = await sendRequest(h, alice.cookie, box, crypto.randomUUID());
  assert.equal(rejected.body.error.code, "send_quota_exceeded");
});

test("cloud draft recipient changes are fenced, consumed atomically and cleared on deletion", async () => {
  const id = crypto.randomUUID(), body = draftBody(box.id, { ...content });
  const saved = await saveDraft(h, alice.cookie, id, body); assert.equal(saved.status, 201, saved.text);
  assert.deepEqual(saved.body.draft.bcc, content.bcc);
  const withDraft = { ...content, draftId: id, draftRevision: 1 };
  assert.equal((await sendRequest(h, alice.cookie, box, crypto.randomUUID(), { ...withDraft, bcc: [] })).body.error.code, "draft_changed");
  const key = crypto.randomUUID(), result = await sendRequest(h, alice.cookie, box, key, withDraft);
  assert.equal(result.status, 201, result.text);
  assert.equal((await h.request(`/api/v1/drafts/${id}`, { cookie: alice.cookie })).body.draft.state, "submitted");
  assert.equal((await deleteDraft(h, alice.cookie, id, 2)).status, 200);
  const row = await h.db.prepare("SELECT * FROM drafts WHERE id=?").bind(id).first();
  assert.equal(row.recipients_json, null); assert.equal(row.to_address, "");
  assert.equal((await sendRequest(h, alice.cookie, box, key, withDraft)).status, 200);
});
