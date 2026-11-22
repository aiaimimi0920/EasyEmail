import assert from "node:assert/strict";
import { test } from "node:test";
import PostalMime from "postal-mime";
import { normalAttachmentsFixture } from "./normal-attachments-fixture.mjs";
import { assetBytes, assetRef } from "./outbox-fixture.mjs";
import { mailInput } from "./normal-send-fixture.mjs";
import { createHash } from "node:crypto";

test("ordinary attachment draft retains immutable manifests and delivers exact binary multipart with private Bcc", async () => {
  const t = await normalAttachmentsFixture();
  try {
    await t.configure(); const asset = await t.upload(assetBytes, { filename: "测试;文档😀.bin" }), attachments = [assetRef(asset)], id = crypto.randomUUID();
    const fields = { cc: ["cc@example.test"], bcc: ["hidden@example.test"] };
    const { state, cleanupPending, ...manifest } = asset;
    const saved = await t.save(id, attachments, fields); assert.equal(saved.status, 201, saved.text); assert.deepEqual(saved.body.draft.attachments, [manifest]);
    assert.equal((await t.save(id, attachments, fields)).body.draft.revision, 1);
    const stored = await t.h.db.prepare("SELECT attachments_json,normal_attachments_json FROM drafts WHERE id=?").bind(id).first();
    assert.equal(stored.attachments_json, null); assert.deepEqual(JSON.parse(stored.normal_attachments_json), [manifest]);
    const key = crypto.randomUUID(), input = { ...mailInput, ...fields, attachments, draftId: id, draftRevision: 1 };
    const sent = await t.send(input, key); assert.equal(sent.status, 201, sent.text); assert.deepEqual(sent.body.outgoing.attachments, [manifest]);
    const parsed = await PostalMime.parse(t.messages[0].replace(/\r\n\.\r\n$/, "\r\n"));
    assert.match(parsed.text, /你好/); assert.equal(parsed.attachments.length, 1); assert.equal(parsed.attachments[0].filename, asset.filename);
    assert.deepEqual(Buffer.from(parsed.attachments[0].content), Buffer.from(assetBytes)); assert.doesNotMatch(t.messages[0], /Bcc:|hidden@example/);
    assert.match(t.writes.join(""), /RCPT TO:<hidden@example.test>/);
    assert.equal((await t.h.request(`${t.path}/drafts/${id}`, { cookie: t.alice.cookie })).body.draft.state, "submitted");
    await t.h.restart(); assert.equal((await t.remove(asset.id)).status, 200);
    assert.equal((await t.send(input, key)).body.outgoing.id, sent.body.outgoing.id); assert.equal(t.messages.length, 1);
    assert.equal((await t.send({ ...input, attachments: [] }, key)).body.error.code, "idempotency_conflict");
    const history = await t.h.request(`${t.path}/outgoing`, { cookie: t.alice.cookie }); assert.deepEqual(history.body.items[0].attachments, [manifest]);
    await t.h.db.prepare("UPDATE retention_policy SET enabled=1,outgoing_days=1,revision=revision+1 WHERE id=1").run();
    await t.h.db.prepare("UPDATE normal_outgoing_messages SET updated_at=1 WHERE id=?").bind(sent.body.outgoing.id).run();
    await t.h.scheduled(); const redacted = await t.h.request(`${t.path}/outgoing?requestKey=${key}`, { cookie: t.alice.cookie });
    assert.deepEqual(redacted.body.outgoing.attachments ?? [], []); assert.equal((await t.send(input, key)).status, 200); assert.equal(t.messages.length, 1);
  } finally { await t.close(); }
});

test("ordinary attachment draft hash binds ordered refs; changed content cannot consume its CAS revision", async () => {
  const t = await normalAttachmentsFixture();
  try {
    await t.configure(); const a = await t.upload(), b = await t.upload(), id = crypto.randomUUID(), refs = [assetRef(a), assetRef(b)];
    assert.equal((await t.save(id, refs)).status, 201);
    const input = { ...mailInput, attachments: [...refs].reverse(), draftId: id, draftRevision: 1 };
    assert.equal((await t.send(input)).body.error.code, "draft_changed"); assert.equal(t.opens.length, 0);
    assert.equal((await t.save(id, [], { expectedRevision: 1 })).status, 200);
    assert.deepEqual((await t.h.request(`${t.path}/drafts/${id}`, { cookie: t.alice.cookie })).body.draft.attachments, []);
    assert.equal((await t.h.request(`${t.path}/drafts/${id}`, { method: "DELETE", cookie: t.alice.cookie, body: { expectedRevision: 2 } })).status, 200);
    assert.equal(await t.h.db.prepare("SELECT normal_attachments_json FROM drafts WHERE id=?").bind(id).first("normal_attachments_json"), null);
  } finally { await t.close(); }
});

test("empty ordinary attachment intent preserves exact W10n hashes and outgoing response shape", async () => {
  const t = await normalAttachmentsFixture();
  try {
    await t.configure(); const id = crypto.randomUUID(), saved = await t.save(id, []); assert.equal(saved.status, 201, saved.text);
    const digest = parts => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
    assert.equal(await t.h.db.prepare("SELECT content_hash FROM drafts WHERE id=?").bind(id).first("content_hash"), digest(["normal-draft-v1", t.id, 1, mailInput.to, [], [], mailInput.subject, mailInput.text]));
    const key = crypto.randomUUID(), sent = await t.send({ ...mailInput, attachments: [] }, key); assert.equal(sent.status, 201, sent.text);
    assert.equal("attachments" in sent.body.outgoing, false);
    assert.equal(await t.h.db.prepare("SELECT request_hash FROM normal_outgoing_messages WHERE request_key=?").bind(key).first("request_hash"), digest(["normal-smtp-send-v1", t.id, 1, 1, mailInput.to, [], [], mailInput.subject, mailInput.text]));
    assert.equal((await t.send(mailInput, key)).status, 200); assert.equal(t.messages.length, 1);
  } finally { await t.close(); }
});
