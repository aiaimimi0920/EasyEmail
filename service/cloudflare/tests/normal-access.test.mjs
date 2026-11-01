import assert from "node:assert/strict";
import { test } from "node:test";
import { normalAccessFixture } from "./normal-access-fixture.mjs";
import { RAW_MESSAGE } from "./normal-read-fixture.mjs";
import { ATTACHMENT, multipartMessage } from "./normal-mime-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";

test("public normal sync, bounded paging, receipt replay and cached detail survive restart without legacy cache writes", async () => {
  const t = await normalAccessFixture(), key = crypto.randomUUID();
  try {
    const result = await t.receive(key); assert.equal(result.status, 200, result.text); assert.equal(result.body.request.state, "committed");
    assert.equal(result.body.request.result.stored, 2); const opens = t.opens.length;
    await t.h.restart(); const replay = await t.receive(key); assert.equal(replay.status, 200, replay.text);
    assert.deepEqual(replay.body, result.body); assert.equal(t.opens.length, opens, "receipt replay cannot reconnect or upload");
    assert.equal((await t.receive(key, 2)).status, 409);
    const first = await t.messages("?limit=1"); assert.equal(first.status, 200, first.text); assert.equal(first.body.items[0].uid, 7);
    assert.ok(first.body.nextCursor); const next = await t.messages(`?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    assert.equal(next.body.items[0].uid, 2); assert.equal(next.body.nextCursor, null);
    const message = await t.message(first.body.items[0].id); assert.equal(message.status, 200, message.text); assert.match(message.body.message.textBody, /742951/);
    assert.equal(t.opens.length, opens); assert.equal(message.text.includes("normal-inbox/v1/"), false);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM messages").first("n"), 0);
    const raw = await t.binary(first.body.items[0].id, "raw"); assert.equal(raw.response.status, 200); assert.deepEqual(raw.bytes, Buffer.from(RAW_MESSAGE));
    assert.equal(raw.response.headers.get("cache-control"), "no-store"); assert.match(raw.response.headers.get("content-disposition"), /^attachment;/);
  } finally { await t.close(); }
});

test("normal reading requires both new account access and message access; downloads independently require attachments access", async () => {
  const t = await normalAccessFixture({ messages: new Map([[1, multipartMessage()]]), uidNext: 2 });
  try {
    assert.equal((await t.receive()).body.request.state, "committed"); const id = (await t.messages()).body.items[0].id;
    for (const scopes of [["messages:read", "attachments:read"], ["mail-accounts:read"], ["mail-accounts:sync"]]) {
      const key = await newKey(t.h, t.alice.cookie, { scopes });
      assert.equal((await t.messages("", { token: key.token, cookie: undefined })).status, 403);
      assert.equal((await t.message(id, { token: key.token, cookie: undefined })).status, 403);
    }
    const read = await newKey(t.h, t.alice.cookie, { scopes: ["mail-accounts:read", "messages:read"] });
    assert.equal((await t.message(id, { token: read.token, cookie: undefined })).status, 200);
    assert.equal((await t.binary(id, "attachments/0", { authorization: `Bearer ${read.token}` })).response.status, 403);
    const download = await newKey(t.h, t.alice.cookie, { scopes: ["mail-accounts:read", "messages:read", "attachments:read"] });
    const file = await t.binary(id, "attachments/0", { authorization: `Bearer ${download.token}` }); assert.equal(file.response.status, 200); assert.deepEqual(file.bytes, Buffer.from(ATTACHMENT));
    const bob = await t.h.register("normal-access-bob");
    assert.equal((await t.message(id, { cookie: bob.cookie })).status, 404);
    const request = (await t.h.request(`${t.base}/sync-requests`, { cookie: t.alice.cookie })).body.items[0];
    assert.equal((await t.h.request(`${t.base}/sync-requests`, { cookie: bob.cookie })).status, 404); assert.ok(request.id);
    assert.equal((await t.h.request(`/api/v1/mailboxes/${t.id}/messages/${id}`, { cookie: t.alice.cookie })).status, 404);
    assert.equal((await t.binary(id, "attachments/100")).response.status, 404);
  } finally { await t.close(); }
});

test("source changes hide old content and invalidate cursors; disabled connection still allows cached reading", async () => {
  const t = await normalAccessFixture();
  try {
    assert.equal((await t.receive()).body.request.state, "committed"); const page = await t.messages("?limit=1"), id = page.body.items[0].id;
    assert.equal((await t.save({ enabled: false }, 1)).status, 200); assert.equal((await t.message(id)).status, 200);
    assert.equal((await t.receive(crypto.randomUUID(), 2)).status, 409);
    assert.equal((await t.save({ username: "other-user", enabled: true }, 2)).status, 200);
    assert.equal((await t.messages()).body.items.length, 0); assert.equal((await t.message(id)).status, 404);
    assert.equal((await t.receive(crypto.randomUUID(), 3)).body.request.state, "committed");
    assert.equal((await t.messages(`?cursor=${encodeURIComponent(page.body.nextCursor)}`)).status, 400);
    assert.equal((await t.message(id)).status, 404);
  } finally { await t.close(); }
});

test("public sync is strict, Origin-bound, independently scoped and records explicit oversized skips", async () => {
  const t = await normalAccessFixture({ reportedSize: 2 * 1024 * 1024 + 1 });
  try {
    assert.equal((await t.receive(crypto.randomUUID(), 1, { origin: "https://evil.invalid" })).status, 403);
    assert.equal((await t.receive(crypto.randomUUID(), 1, { headers: {} })).status, 400);
    assert.equal((await t.receive(crypto.randomUUID(), 1, { body: { expectedRevision: 1, hostname: "127.0.0.1" } })).status, 400);
    assert.equal(t.opens.length, 0);
    const key = await newKey(t.h, t.alice.cookie, { scopes: ["mail-accounts:sync"] });
    const result = await t.receive(crypto.randomUUID(), 1, { token: key.token, cookie: undefined, origin: null });
    assert.equal(result.body.request.state, "committed", result.text); assert.equal(result.body.request.result.skipped.length, 2);
    assert.equal((await t.messages()).body.items.length, 0);
    assert.equal(result.text.includes("Synthetic"), false);
  } finally { await t.close(); }
});
