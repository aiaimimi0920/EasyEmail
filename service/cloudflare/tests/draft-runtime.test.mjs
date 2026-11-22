import assert from "node:assert/strict";
import { before, after, beforeEach, test } from "node:test";
import { draftFixture, draftBody, draftPath, saveDraft, deleteDraft, ok } from "./draft-fixture.mjs";
import { newKey, seedMailbox } from "./runtime-harness.mjs";

let f, h, alice, bob, box;
before(async () => { f = await draftFixture(); ({ h, alice, bob, box } = f); }, { timeout: 90000 });
after(async () => { await f?.close(); });
beforeEach(async () => { await h.resetLimits(); });

test("cloud drafts persist incomplete content, update by revision and restore after Worker restart without sending", async () => {
  const id = crypto.randomUUID(), body = draftBody(null, { to: "partial@", subject: "", text: "" });
  let draft = ok(await saveDraft(h, alice.cookie, id, body), 201);
  assert.equal(draft.revision, 1); assert.equal(draft.state, "editing"); assert.equal(draft.mailboxId, null);
  assert.deepEqual(ok(await saveDraft(h, alice.cookie, id, body)), draft);
  draft = ok(await saveDraft(h, alice.cookie, id, draftBody(box, { expectedRevision: 1 })));
  assert.equal(draft.revision, 2);
  await h.restart();
  assert.deepEqual(ok(await h.request(draftPath(id), { cookie: alice.cookie })), draft);
  assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM outgoing_messages").first("n"), 0);
  assert.equal((await h.request(draftPath(), { cookie: alice.cookie })).body.items.some(row => row.id === id), true);
});

test("two devices cannot overwrite a newer revision or resurrect a deleted draft", async () => {
  const id = crypto.randomUUID(); ok(await saveDraft(h, alice.cookie, id, draftBody(box)), 201);
  const responses = await Promise.all(["device A", "device B"].map(text => saveDraft(h, alice.cookie, id, draftBody(box, { expectedRevision: 1, text }))));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  const winner = ok(await h.request(draftPath(id), { cookie: alice.cookie })); assert.equal(winner.revision, 2);
  assert.equal((await deleteDraft(h, alice.cookie, id, 1)).status, 409);
  ok(await deleteDraft(h, alice.cookie, id, 2)); ok(await deleteDraft(h, alice.cookie, id, 2));
  assert.equal((await h.request(draftPath(id), { cookie: alice.cookie })).status, 404);
  assert.equal((await saveDraft(h, alice.cookie, id, draftBody(box, { expectedRevision: 2 }))).status, 409);
  assert.equal((await saveDraft(h, alice.cookie, id, draftBody(box))).status, 409);
  const tombstone = await h.db.prepare("SELECT * FROM drafts WHERE id=? AND user_id=?").bind(id, alice.id).first();
  assert.equal(tombstone.state, "deleted"); assert.equal(tombstone.text_body, ""); assert.equal(tombstone.to_address, "");
});

test("draft scopes stay separate from sending, old keys and other users; session writes require Origin", async () => {
  const id = crypto.randomUUID(); ok(await saveDraft(h, alice.cookie, id, draftBody(box)), 201);
  const old = await newKey(h, alice.cookie, { scopes: ["messages:read", "messages:send"] });
  const reader = await newKey(h, alice.cookie, { scopes: ["drafts:read"] });
  const writer = await newKey(h, alice.cookie, { scopes: ["drafts:write"] });
  for (const token of [old.token, writer.token]) assert.equal((await h.request(draftPath(id), { token })).status, 403);
  assert.equal((await h.request(draftPath(id), { token: reader.token })).status, 200);
  assert.equal((await saveDraft(h, null, id, draftBody(box, { expectedRevision: 1 }), { token: reader.token })).status, 403);
  assert.equal((await saveDraft(h, null, id, draftBody(box, { expectedRevision: 1, text: "write only" }), { token: writer.token, origin: null })).status, 200);
  for (const options of [{ cookie: bob.cookie }, { cookie: alice.cookie, origin: "https://untrusted.test" }]) {
    assert.equal((await saveDraft(h, options.cookie, id, draftBody(box, { expectedRevision: 2 }), options)).status, options.cookie === bob.cookie ? 404 : 403);
  }
  assert.equal((await h.request(draftPath(id), { cookie: bob.cookie })).status, 404);
  assert.equal((await deleteDraft(h, bob.cookie, id, 2)).status, 404);
  assert.equal((await h.request(draftPath(), { cookie: bob.cookie })).body.items.length, 0);
  const foreign = await seedMailbox(h, bob.id, "foreign@example.test");
  assert.equal((await saveDraft(h, alice.cookie, crypto.randomUUID(), draftBody(foreign))).status, 404);
});

test("draft pagination is user scoped, returns summaries only and rejects malformed input", async () => {
  const ids = [];
  for (let i = 0; i < 3; i++) { const id = crypto.randomUUID(); ids.push(id); ok(await saveDraft(h, bob.cookie, id, draftBody()), 201); }
  const first = await h.request(draftPath() + "?limit=2", { cookie: bob.cookie });
  assert.equal(first.body.items.length, 2); assert.equal("text" in first.body.items[0], false);
  const next = await h.request(draftPath() + `?limit=2&cursor=${first.body.nextCursor}`, { cookie: bob.cookie });
  assert.equal(new Set([...first.body.items, ...next.body.items].map(row => row.id)).size, 3);
  assert.equal((await h.request(draftPath() + `?cursor=${ids[0]}`, { cookie: alice.cookie })).status, 400);
  for (const query of ["?limit=0", "?state=surprise", "?limit=1&limit=2"]) assert.equal((await h.request(draftPath() + query, { cookie: alice.cookie })).status, 400);
  for (const fields of [{ expectedRevision: -1 }, { expectedRevision: 0.5 }, { to: "a\nb" }, { subject: "x\r\ny" }, { text: "a\0b" }, { html: "<b>x</b>" }, { replyToMessageId: crypto.randomUUID() }]) {
    assert.equal((await saveDraft(h, alice.cookie, crypto.randomUUID(), draftBody(box, fields))).status, 400);
  }
  assert.equal((await saveDraft(h, alice.cookie, crypto.randomUUID(), draftBody(box, { text: "中".repeat(3000) }))).status, 413);
});
