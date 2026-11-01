import assert from "node:assert/strict";
import { test } from "node:test";
import { newKey } from "./runtime-harness.mjs";
import { assetBytes, assetMetadata, assetRef, bytesHash, outboxFixture, putAsset } from "./outbox-fixture.mjs";
import { sendBody, sendCalls, sendRequest } from "./send-fixture.mjs";

test("private immutable binary uploads survive restart, download exact bytes and replay one reservation", async () => {
  const t = await outboxFixture();
  try {
    const key = crypto.randomUUID(), first = await t.reserve(assetMetadata(), key); assert.equal(first.status, 201, first.text);
    assert.equal((await t.reserve(assetMetadata(), key)).body.attachment.id, first.body.attachment.id);
    assert.equal((await t.reserve({ ...assetMetadata(), filename: "different.bin" }, key)).status, 409);
    const uploaded = await putAsset(t.h, t.alice, first.body.attachment.id); assert.equal(uploaded.status, 200, uploaded.text);
    const asset = uploaded.body.attachment; assert.equal(asset.state, "ready"); assert.equal(asset.sha256, bytesHash(assetBytes));
    assert.equal((await putAsset(t.h, t.alice, asset.id, Uint8Array.from([1]))).status, 400);
    await t.h.restart();
    const downloaded = await fetch(new URL(`/api/v1/outbox-attachments/${asset.id}/content`, t.h.baseUrl), { headers: { cookie: t.alice.cookie } });
    assert.equal(downloaded.status, 200); assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()), assetBytes);
    assert.equal(downloaded.headers.get("x-content-type-options"), "nosniff"); assert.match(downloaded.headers.get("content-disposition"), /^attachment;/);
    assert.equal(downloaded.headers.get("cache-control"), "no-store");
    const objects = (await (await t.h.bucket()).list()).objects;
    assert.equal(objects.length, 1); assert.equal(objects[0].size, assetBytes.length);
    assert.equal(objects[0].version, (await t.h.db.prepare("SELECT object_version FROM outbox_assets WHERE id=?").bind(asset.id).first()).object_version);
    assert.equal((await t.h.db.prepare("SELECT COUNT(*) n FROM outbox_assets").first()).n, 1);
  } finally { await t.close(); }
});

test("upload ownership, scopes, Origin, actual bytes, digest and missing storage fail closed", async () => {
  const t = await outboxFixture();
  try {
    const created = await t.reserve(); assert.equal(created.status, 201, created.text); const id = created.body.attachment.id;
    const bob = await t.h.register("outbox-other"), reader = await newKey(t.h, t.alice.cookie, { scopes: ["attachments:read"] });
    assert.equal((await putAsset(t.h, bob, id)).status, 404);
    assert.equal((await putAsset(t.h, t.alice, id, assetBytes, { origin: "https://foreign.invalid" })).status, 403);
    assert.equal((await putAsset(t.h, t.alice, id, assetBytes, { token: reader.token, origin: null })).status, 403);
    assert.equal((await putAsset(t.h, t.alice, id, assetBytes.map(v => v ^ 1))).status, 400);
    for (const body of [{ ...assetMetadata(), size: 0 }, { ...assetMetadata(), size: 2097153 }, { ...assetMetadata(), filename: "bad\r\nname" }]) {
      assert.equal((await t.reserve(body)).status, 400);
    }
    assert.equal((await (await t.h.bucket()).list()).objects.length, 0);
    const uploaded = await t.upload();
    assert.equal((await t.h.request(`/api/v1/outbox-attachments/${uploaded.id}`, { cookie: bob.cookie })).status, 404);
  } finally { await t.close(); }
});

test("one attachment binding dispatch preserves exact binary, cloud draft fencing and immutable replay after removal", async () => {
  const t = await outboxFixture();
  try {
    const asset = await t.upload(), attachments = [assetRef(asset)], id = crypto.randomUUID();
    const saved = await t.h.request(`/api/v1/drafts/${id}`, { method: "PUT", cookie: t.alice.cookie,
      body: { expectedRevision: 0, mailboxId: t.box.id, ...sendBody, attachments } });
    assert.equal(saved.status, 201, saved.text); assert.equal(saved.body.draft.attachments[0].filename, asset.filename);
    const key = crypto.randomUUID(), body = { ...sendBody, attachments, draftId: id, draftRevision: 1 };
    const sent = await sendRequest(t.h, t.alice.cookie, t.box, key, body); assert.equal(sent.status, 201, sent.text);
    const file = sendCalls(t.f)[0].body.attachments[0]; assert.equal(file.disposition, "attachment"); assert.equal(file.filename, asset.filename);
    assert.deepEqual(new Uint8Array(Buffer.from(file.content, "base64")), assetBytes);
    const removed = await t.h.request(`/api/v1/outbox-attachments/${asset.id}`, { method: "DELETE", cookie: t.alice.cookie, body: {} });
    assert.equal(removed.status, 200, removed.text); assert.equal(removed.body.attachment.cleanupPending, false);
    assert.equal(removed.body.cleanupPending, false); await t.h.restart();
    assert.equal((await sendRequest(t.h, t.alice.cookie, t.box, key, body)).status, 200); assert.equal(sendCalls(t.f).length, 1);
    assert.equal((await sendRequest(t.h, t.alice.cookie, t.box, crypto.randomUUID(), { ...sendBody, attachments })).status, 409);
  } finally { await t.close(); }
});
