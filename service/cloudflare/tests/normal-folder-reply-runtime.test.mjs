import assert from "node:assert/strict";
import { test } from "node:test";
import PostalMime from "postal-mime";
import { folderReplyFixture } from "./normal-folder-reply-fixture.mjs";
import { mailInput } from "./normal-send-fixture.mjs";
import { uploadNormalAsset } from "./normal-attachments-fixture.mjs";
import { assetBytes, assetRef } from "./outbox-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";

test("folder reply selects the exact source despite the same INBOX UID and keeps the old preview INBOX-only", async () => {
  const t = await folderReplyFixture();
  try {
    await t.configure(); const folder = await t.seedFolder(), inbox = await t.seed();
    const preview = await t.h.request(`${folder.path}/reply`, { cookie: t.alice.cookie });
    assert.equal(preview.status, 200, preview.text); assert.equal(preview.body.reply.serverFolderId, folder.folderId);
    assert.equal(preview.body.reply.to, "archive@example.test"); assert.equal(preview.body.reply.messageId, folder.id);
    assert.equal((await t.h.request(`${t.path}/messages/${folder.id}/reply`, { cookie: t.alice.cookie })).status, 404);
    assert.equal((await t.h.request(`${t.path}/server-folders/${folder.folderId}/messages/${inbox.id}/reply`, { cookie: t.alice.cookie })).status, 404);
    const body = { ...mailInput, to: preview.body.reply.to, replyToMessageId: folder.id }, key = crypto.randomUUID();
    const sent = await t.send(body, key); assert.equal(sent.status, 201, sent.text);
    assert.match(t.messages[0], /\r\nIn-Reply-To: <archive@example\.test>\r\n/);
    assert.match(t.messages[0], /\r\nReferences: <folder-root@example\.test>\r\n <archive@example\.test>\r\n/);
    await (await t.h.bucket("INBOX")).delete(folder.rawKey);
    await t.h.db.prepare("UPDATE normal_server_folder_catalogs SET folders='[]' WHERE account_id=?").bind(t.id).run();
    await t.h.restart(); assert.equal((await t.send(body, key)).status, 200); assert.equal(t.messages.length, 1);
    assert.equal((await t.send({ ...body, replyToMessageId: inbox.id }, key)).body.error.code, "idempotency_conflict");
  } finally { await t.close(); }
});

test("folder reply draft reopens with attachments and is atomically consumed by the existing direct sender", async () => {
  const t = await folderReplyFixture();
  try {
    await t.configure(); const source = await t.seedFolder(), asset = await uploadNormalAsset(t), id = crypto.randomUUID();
    const attachments = [assetRef(asset)], route = `${t.path}/drafts/${id}`;
    const body = { accountRevision: 1, expectedRevision: 0, to: "archive@example.test", subject: "Re: Reply acceptance", text: "Folder draft", replyToMessageId: source.id, attachments };
    const save = await t.h.request(route, { cookie: t.alice.cookie, method: "PUT", body }); assert.equal(save.status, 201, save.text);
    await t.h.restart(); const read = await t.h.request(route, { cookie: t.alice.cookie });
    assert.equal(read.body.draft.replyToMessageId, source.id); assert.equal(read.body.draft.attachments[0].id, asset.id);
    const sent = await t.send({ ...mailInput, to: body.to, subject: body.subject, text: body.text, replyToMessageId: source.id, attachments, draftId: id, draftRevision: 1 });
    assert.equal(sent.status, 201, sent.text); assert.equal((await t.h.request(route, { cookie: t.alice.cookie })).body.draft.state, "submitted");
    const mime = await PostalMime.parse(t.messages[0].replace(/\r\n\.\r\n$/, "\r\n"));
    assert.deepEqual(Buffer.from(mime.attachments[0].content), Buffer.from(assetBytes)); assert.equal(mime.inReplyTo, "<archive@example.test>");
  } finally { await t.close(); }
});

test("folder reply queued intent survives restart and revocation of the API key that authorized it", async () => {
  const t = await folderReplyFixture();
  try {
    await t.configure(); const source = await t.seedFolder();
    const key = await newKey(t.h, t.alice.cookie, { scopes: ["mail-accounts:read", "messages:read", "mail-accounts:send", "mail-accounts:schedule"] });
    const queued = await t.enqueue({ ...mailInput, replyToMessageId: source.id }, crypto.randomUUID(), { cookie: null, token: key.token });
    assert.equal(queued.status, 201, queued.text); assert.equal(t.opens.length, 0);
    await t.h.db.prepare("UPDATE api_keys SET revoked_at=1 WHERE id=?").bind(key.id).run();
    await t.h.restart(); await t.tick();
    const read = await t.h.request(`${t.path}/send-jobs/${queued.body.job.id}`, { cookie: t.alice.cookie });
    assert.equal(read.body.job.state, "accepted", read.text); assert.equal(t.messages.length, 1);
    await t.tick(); assert.equal(t.messages.length, 1); assert.match(t.messages[0], /In-Reply-To: <archive@example.test>/);
  } finally { await t.close(); }
});
