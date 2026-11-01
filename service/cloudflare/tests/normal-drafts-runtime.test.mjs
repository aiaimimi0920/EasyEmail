import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { normalSendFixture, mailInput } from "./normal-send-fixture.mjs";

test("ordinary drafts share CAS storage, isolate temporary routes and submit atomically with SMTP replay", async () => {
  const t = await normalSendFixture();
  try {
    await t.configure(); const id = crypto.randomUUID(), route = `${t.path}/drafts/${id}`;
    const { expectedRevision, smtpRevision, ...content } = mailInput;
    const body = { expectedRevision: 0, accountRevision: 1, ...content };
    const save = await t.h.request(route, { cookie: t.alice.cookie, method: "PUT", body });
    assert.equal(save.status, 201, save.text); assert.equal(save.body.draft.normalAccountId, t.id);
    assert.equal(save.body.draft.accountRevision, 1); assert.equal(save.body.draft.mailboxId, null);
    assert.equal((await t.h.request(route, { cookie: t.alice.cookie, method: "PUT", body })).body.draft.revision, 1);
    const list = await t.h.request(`${t.path}/drafts?limit=1`, { cookie: t.alice.cookie }); assert.equal(list.body.items[0].id, id);
    assert.equal((await t.h.request("/api/v1/drafts", { cookie: t.alice.cookie })).body.items.length, 0);
    assert.equal((await t.h.request(`/api/v1/drafts/${id}`, { cookie: t.alice.cookie })).status, 404);
    const key = crypto.randomUUID(), input = { ...mailInput, draftId: id, draftRevision: 1 };
    const sent = await t.send(input, key); assert.equal(sent.status, 201, sent.text);
    const read = await t.h.request(route, { cookie: t.alice.cookie }); assert.equal(read.body.draft.state, "submitted");
    assert.equal(read.body.draft.revision, 2); assert.equal(read.body.draft.outgoingId, sent.body.outgoing.id);
    await t.h.restart(); assert.equal((await t.send(input, key)).body.outgoing.id, sent.body.outgoing.id);
    assert.equal((await t.send(input)).body.error.code, "draft_submitted"); assert.equal(t.messages.length, 1);
    assert.equal((await t.h.request(route, { cookie: t.alice.cookie, method: "DELETE", body: { expectedRevision: 2 } })).status, 200);
    assert.equal((await t.send(input, key)).status, 200); assert.equal(t.messages.length, 1);
  } finally { await t.close(); }
});

test("ordinary direct sends without draft identity retain the exact W10l request hash", async () => {
  const t = await normalSendFixture();
  try {
    await t.configure(); const key = crypto.randomUUID(), response = await t.send(mailInput, key); assert.equal(response.status, 201, response.text);
    const expected = createHash("sha256").update(JSON.stringify(["normal-smtp-send-v1", t.id, 1, 1, mailInput.to, [], [], mailInput.subject, mailInput.text])).digest("hex");
    assert.equal(await t.h.db.prepare("SELECT request_hash FROM normal_outgoing_messages WHERE request_key=?").bind(key).first("request_hash"), expected);
    assert.equal((await t.send({ ...mailInput, draftId: crypto.randomUUID(), draftRevision: 1 }, key)).body.error.code, "idempotency_conflict");
    assert.equal((await t.send(mailInput, key)).status, 200); assert.equal(t.opens.length, 1);
  } finally { await t.close(); }
});

test("ordinary draft submission remains consumed on ambiguous DATA and rejects unsaved content", async () => {
  const t = await normalSendFixture();
  try {
    await t.configure(); const id = crypto.randomUUID(), route = `${t.path}/drafts/${id}`;
    const { expectedRevision, smtpRevision, ...content } = mailInput;
    const saved = await t.h.request(route, { cookie: t.alice.cookie, method: "PUT", body: { ...content, expectedRevision: 0, accountRevision: 1 } });
    assert.equal(saved.status, 201, saved.text);
    const input = { ...mailInput, draftId: id, draftRevision: 1 };
    assert.equal((await t.send({ ...input, text: "unsaved edit" })).body.error.code, "draft_changed");
    assert.equal(t.opens.length, 0); t.mode("drop-final"); const key = crypto.randomUUID();
    const sent = await t.send(input, key); assert.equal(sent.body.outgoing.state, "unknown", sent.text);
    assert.equal((await t.h.request(route, { cookie: t.alice.cookie })).body.draft.state, "submitted");
    assert.equal((await t.send(input)).body.error.code, "draft_submitted"); assert.equal(t.opens.length, 1);
  } finally { await t.close(); }
});
