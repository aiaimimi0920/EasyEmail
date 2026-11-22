import assert from "node:assert/strict";
import { test } from "node:test";
import { newKey } from "./runtime-harness.mjs";
import { assetBytes, assetMetadata, assetRef, outboxFixture, putAsset } from "./outbox-fixture.mjs";
import { sendBody, sendCalls, sendRequest } from "./send-fixture.mjs";

async function streamed(t, id, bytes, headers = {}) {
  const response = await fetch(new URL(`/api/v1/outbox-attachments/${id}/content`, t.h.baseUrl), { method: "PUT", duplex: "half",
    headers: { cookie: t.alice.cookie, origin: t.h.appOrigin, "content-type": "application/octet-stream", ...headers },
    body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) });
  return { status: response.status, body: await response.json() };
}
test("actual streamed bytes, digest, media type, encoding and strict reference parsing fail before external dispatch", async () => {
  const t = await outboxFixture();
  try {
    const id = (await t.reserve()).body.attachment.id;
    assert.equal((await streamed(t, id, Uint8Array.from([...assetBytes, 1]))).status, 413);
    assert.equal((await streamed(t, id, assetBytes.slice(1))).status, 400);
    assert.equal((await streamed(t, id, assetBytes.map(v => v ^ 1))).status, 400);
    assert.equal((await streamed(t, id, assetBytes, { "content-type": "text/plain" })).status, 415);
    assert.equal((await streamed(t, id, assetBytes, { "content-encoding": "gzip" })).status, 415);
    assert.equal((await (await t.h.bucket()).list()).objects.length, 0);
    const asset = await t.upload(), ref = assetRef(asset);
    for (const attachments of [null, [ref, ref], [{ ...ref, filename: "spoof" }], [{ ...ref, version: "ff" }], Array(6).fill(ref)]) {
      assert.equal((await sendRequest(t.h, t.alice.cookie, t.box, crypto.randomUUID(), { ...sendBody, attachments })).status, 400);
    }
    const bob = await t.h.register("outbox-boundary-other");
    const response = await t.h.request(`/api/v1/drafts/${crypto.randomUUID()}`, { method: "PUT", cookie: bob.cookie,
      body: { expectedRevision: 0, ...sendBody, attachments: [ref] } });
    assert.equal(response.status, 404); assert.equal(sendCalls(t.f).length, 0);
  } finally { await t.close(); }
});

test("2 MiB binary sends once, but aggregate byte cap rejects multiple otherwise-valid resources", async () => {
  const t = await outboxFixture();
  try {
    const bytes = new Uint8Array(2097152).map((_, i) => i % 251), a = await t.upload(bytes), b = await t.upload(bytes);
    const oversized = await sendRequest(t.h, t.alice.cookie, t.box, crypto.randomUUID(), { ...sendBody, attachments: [assetRef(a), assetRef(b)] });
    assert.equal(oversized.status, 413); assert.equal(sendCalls(t.f).length, 0);
    const sent = await sendRequest(t.h, t.alice.cookie, t.box, crypto.randomUUID(), { ...sendBody, attachments: [assetRef(a)] });
    assert.equal(sent.status, 201, sent.text);
    assert.deepEqual(new Uint8Array(Buffer.from(sendCalls(t.f)[0].body.attachments[0].content, "base64")), bytes);
  } finally { await t.close(); }
});

test("old send keys do not acquire attachment scopes; writer and reader privileges remain independent", async () => {
  const t = await outboxFixture();
  try {
    const asset = await t.upload(), body = { ...sendBody, attachments: [assetRef(asset)] };
    const sendOnly = await newKey(t.h, t.alice.cookie, { scopes: ["messages:send"] });
    const writer = await newKey(t.h, t.alice.cookie, { scopes: ["attachments:write"] });
    const reader = await newKey(t.h, t.alice.cookie, { scopes: ["attachments:read"] });
    assert.equal((await sendRequest(t.h, null, t.box, crypto.randomUUID(), body, { token: sendOnly.token, origin: null })).status, 403);
    assert.equal((await t.reserve(assetMetadata(), crypto.randomUUID(), { token: reader.token, cookie: null, origin: null })).status, 403);
    assert.equal((await t.h.request(`/api/v1/outbox-attachments/${asset.id}`, { token: writer.token, origin: null })).status, 403);
    assert.equal((await t.h.request(`/api/v1/outbox-attachments/${asset.id}/check`, { method: "POST", token: reader.token, origin: null, body: {} })).status, 403);
    assert.equal(sendCalls(t.f).length, 0);
  } finally { await t.close(); }
});

test("absent storage and single-address worker transport explicitly reject attachments without a fallback send", async () => {
  for (const options of [{ storage: false }, { transport: "worker" }]) {
    const t = await outboxFixture(options);
    try {
      const policy = await t.h.request("/api/v1/outbox-attachments", { cookie: t.alice.cookie });
      assert.equal(policy.body.policy.available, options.storage !== false);
      if (options.storage === false) {
        assert.equal((await t.reserve()).body.error.code, "outbox_storage_unavailable");
        const result = await sendRequest(t.h, t.alice.cookie, t.box, crypto.randomUUID(), { ...sendBody, attachments: [{ id: crypto.randomUUID(), version: "00".repeat(32) }] });
        assert.equal(result.body.error.code, "outbox_storage_unavailable");
      } else {
        const asset = await t.upload();
        const result = await sendRequest(t.h, t.alice.cookie, t.box, crypto.randomUUID(), { ...sendBody, attachments: [assetRef(asset)] });
        assert.equal(result.body.error.code, "attachment_send_unavailable");
      }
      assert.equal(sendCalls(t.f).length, 0); assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM outgoing_messages").first("n"), 0);
    } finally { await t.close(); }
  }
});

test("draft consumption failure rolls back attachment-bearing guard; unknown send replay survives expiry and cleanup without resend", async () => {
  const t = await outboxFixture();
  try {
    const asset = await t.upload(), id = crypto.randomUUID(), content = { ...sendBody, attachments: [assetRef(asset)] };
    const saved = await t.h.request(`/api/v1/drafts/${id}`, { method: "PUT", cookie: t.alice.cookie, body: { expectedRevision: 0, mailboxId: t.box.id, ...content } });
    assert.equal(saved.status, 201, saved.text);
    await t.h.db.exec("CREATE TRIGGER fail_attachment_consume BEFORE UPDATE ON drafts WHEN NEW.state='submitted' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    const body = { ...content, draftId: id, draftRevision: 1 }, key = crypto.randomUUID();
    try { assert.equal((await sendRequest(t.h, t.alice.cookie, t.box, key, body)).status, 500); }
    finally { await t.h.db.exec("DROP TRIGGER fail_attachment_consume"); }
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM outgoing_messages").first("n"), 0); assert.equal(sendCalls(t.f).length, 0);
    t.f.modes.set("/cf/admin/send_mail_by_binding", "disconnect");
    assert.equal((await sendRequest(t.h, t.alice.cookie, t.box, key, body)).body.outgoing.state, "unknown");
    await t.h.db.exec("UPDATE outbox_assets SET expires_at=unixepoch()-1"); await t.h.scheduled(); await t.h.restart();
    assert.equal((await (await t.h.bucket()).list()).objects.length, 0);
    assert.equal((await sendRequest(t.h, t.alice.cookie, t.box, key, body)).body.outgoing.state, "unknown");
    assert.equal(sendCalls(t.f).length, 1);
    assert.equal((await sendRequest(t.h, t.alice.cookie, t.box, crypto.randomUUID(), body)).status, 409);
  } finally { await t.close(); }
});
