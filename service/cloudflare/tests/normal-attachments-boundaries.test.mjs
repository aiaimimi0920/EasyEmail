import assert from "node:assert/strict";
import { test } from "node:test";
import PostalMime from "postal-mime";
import { normalAttachmentsFixture, uploadNormalAsset } from "./normal-attachments-fixture.mjs";
import { normalReplyFixture } from "./normal-reply-fixture.mjs";
import { normalSendFixture, mailInput } from "./normal-send-fixture.mjs";
import { assetBytes, assetRef } from "./outbox-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";

test("ordinary attachment authority remains separate from send/draft authority and cannot cross owners", async () => {
  const t = await normalAttachmentsFixture();
  try {
    await t.configure(); const a = await t.upload(), attachments = [assetRef(a)], id = crypto.randomUUID();
    const sender = await newKey(t.h, t.alice.cookie, { scopes: ["mail-accounts:read", "mail-accounts:send", "drafts:write"] });
    const extra = { cookie: null, token: sender.token, origin: null };
    assert.equal((await t.send({ ...mailInput, attachments }, crypto.randomUUID(), extra)).status, 403);
    assert.equal((await t.save(id, attachments, {}, extra)).status, 403);
    const bob = await t.h.register("normal-asset-owner-bob");
    const foreign = await t.h.request("/api/v1/outbox-attachments", { method: "POST", cookie: bob.cookie,
      headers: { "idempotency-key": crypto.randomUUID() }, body: { filename: "private.bin", mimeType: "application/octet-stream", size: 1, sha256: "a".repeat(64) } });
    assert.equal((await t.send({ ...mailInput, attachments: [assetRef(foreign.body.attachment)] })).status, 404);
    for (const refs of [[...attachments, ...attachments], [{ ...attachments[0], filename: "spoof" }], [{ ...attachments[0], version: "b".repeat(64) }], Array(6).fill(attachments[0])]) {
      assert.ok((await t.send({ ...mailInput, attachments: refs })).status >= 400);
    }
    assert.equal(t.opens.length, 0); assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_outgoing_messages").first("n"), 0);
    const reader = await newKey(t.h, t.alice.cookie, { scopes: ["mail-accounts:send", "attachments:read"] });
    assert.equal((await t.send({ ...mailInput, attachments }, crypto.randomUUID(), { cookie: null, token: reader.token, origin: null })).status, 201);
  } finally { await t.close(); }
});

test("expired, deleted, missing or corrupted R2 bytes fail before consuming ordinary draft, quota or SMTP", async () => {
  const t = await normalAttachmentsFixture();
  try {
    await t.configure();
    for (const fault of ["expired", "deleted", "missing", "sha256", "length"]) {
      const a = await t.upload(), attachments = [assetRef(a)], id = crypto.randomUUID(); assert.equal((await t.save(id, attachments)).status, 201);
      const row = await t.h.db.prepare("SELECT * FROM outbox_assets WHERE id=?").bind(a.id).first(), bucket = await t.h.bucket();
      if (fault === "expired") await t.h.db.prepare("UPDATE outbox_assets SET expires_at=1 WHERE id=?").bind(a.id).run();
      if (fault === "deleted") await t.remove(a.id);
      if (fault === "missing") await bucket.delete(row.object_key);
      if (["sha256", "length"].includes(fault)) {
        const value = await bucket.put(row.object_key, fault === "length" ? new Uint8Array(2) : new Uint8Array(assetBytes.length));
        await t.h.db.prepare("UPDATE outbox_assets SET object_version=?,object_etag=? WHERE id=?").bind(value.version, value.etag, a.id).run();
      }
      const result = await t.send({ ...mailInput, attachments, draftId: id, draftRevision: 1 }); assert.equal(result.status, 409, result.text);
      assert.equal((await t.h.request(`${t.path}/drafts/${id}`, { cookie: t.alice.cookie })).body.draft.state, "editing");
    }
    assert.equal(t.opens.length, 0); assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_outgoing_messages").first("n"), 0);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM send_recipient_charges").first("n"), 0);
  } finally { await t.close(); }
});

test("ordinary SMTP reuses 2 MiB binary upload and rejects a 4 MiB aggregate before reservation", async () => {
  const t = await normalAttachmentsFixture();
  try {
    await t.configure(); const bytes = Buffer.alloc(2 * 1024 * 1024); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    const a = await t.upload(bytes), b = await t.upload(bytes);
    assert.equal((await t.send({ ...mailInput, attachments: [assetRef(a), assetRef(b)] })).status, 413); assert.equal(t.opens.length, 0);
    assert.equal((await t.send({ ...mailInput, attachments: [assetRef(a)] })).status, 201);
    const parsed = await PostalMime.parse(t.messages[0].replace(/\r\n\.\r\n$/, "\r\n")); assert.deepEqual(Buffer.from(parsed.attachments[0].content), bytes);
  } finally { await t.close(); }
});

test("ordinary reply drafts keep server-owned threading while carrying attachment manifests", async () => {
  const t = await normalReplyFixture(false, { r2Buckets: { OUTBOX: "normal-reply-attachments" } });
  try {
    await t.configure(); const source = await t.seed(), a = await uploadNormalAsset(t), id = crypto.randomUUID(), attachments = [assetRef(a)];
    const { expectedRevision, smtpRevision, ...content } = mailInput;
    const saved = await t.h.request(`${t.path}/drafts/${id}`, { method: "PUT", cookie: t.alice.cookie,
      body: { ...content, expectedRevision: 0, accountRevision: 1, attachments, replyToMessageId: source.id } });
    assert.equal(saved.status, 201, saved.text);
    const result = await t.send({ ...mailInput, attachments, replyToMessageId: source.id, draftId: id, draftRevision: 1 }); assert.equal(result.status, 201, result.text);
    const parsed = await PostalMime.parse(t.messages[0].replace(/\r\n\.\r\n$/, "\r\n")); assert.equal(parsed.inReplyTo, "<original@example.test>");
    assert.deepEqual(Buffer.from(parsed.attachments[0].content), Buffer.from(assetBytes));
  } finally { await t.close(); }
});

test("ordinary attachment intent never silently falls back when OUTBOX is not configured", async () => {
  const t = await normalSendFixture();
  try {
    await t.configure(); const refs = [{ id: crypto.randomUUID(), version: "a".repeat(64) }];
    assert.equal((await t.send({ ...mailInput, attachments: refs })).body.error.code, "outbox_storage_unavailable"); assert.equal(t.opens.length, 0);
  } finally { await t.close(); }
});
