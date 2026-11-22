import assert from "node:assert/strict";
import { test } from "node:test";
import { queueFixture } from "./queue-fixture.mjs";
import { assetBytes, assetRef } from "./outbox-fixture.mjs";
import { sendBody, sendCalls, sendRequest } from "./send-fixture.mjs";

test("draft enqueue consumes one immutable intent transactionally; cancelling never restores consumed draft", async () => {
  const t = await queueFixture();
  try {
    const id = crypto.randomUUID(), key = crypto.randomUUID(), body = { ...sendBody, draftId: id, draftRevision: 1 };
    const saved = await t.h.request(`/api/v1/drafts/${id}`, { method: "PUT", cookie: t.alice.cookie,
      body: { ...sendBody, mailboxId: t.box.id, expectedRevision: 0 } });
    assert.equal(saved.status, 201, saved.text);
    await t.h.db.exec("CREATE TRIGGER fail_queue_draft BEFORE UPDATE ON drafts WHEN NEW.state='submitted' BEGIN SELECT RAISE(ABORT,'synthetic consume failure'); END");
    try { assert.equal((await t.enqueue(body, key)).status, 500); }
    finally { await t.h.db.exec("DROP TRIGGER fail_queue_draft"); }
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM send_jobs").first("n"), 0);
    assert.equal((await t.h.db.prepare("SELECT revision FROM drafts WHERE id=?").bind(id).first()).revision, 1);
    const result = await t.enqueue(body, key); assert.equal(result.status, 201, result.text);
    const draft = await t.h.db.prepare("SELECT * FROM drafts WHERE id=?").bind(id).first();
    assert.equal(draft.state, "submitted"); assert.equal(draft.revision, 2); assert.equal(draft.outgoing_id, null);
    assert.equal((await sendRequest(t.h, t.alice.cookie, t.box, crypto.randomUUID(), body)).body.error.code, "draft_submitted");
    assert.equal((await t.action(result.body.job, "cancel")).status, 200);
    assert.equal((await t.h.db.prepare("SELECT state FROM drafts WHERE id=?").bind(id).first()).state, "submitted");
    await t.tick(); assert.equal(sendCalls(t.f).length, 0);
  } finally { await t.close(); }
});

test("queued attachments pin deletion, constrain schedule, and hand exact binary to one outgoing", async () => {
  const t = await queueFixture();
  try {
    const asset = await t.upload(), attachments = [assetRef(asset)];
    const invalid = await t.enqueue({ ...sendBody, attachments, scheduledAt: asset.expiresAt + 1 });
    assert.equal(invalid.body.error.code, "attachment_expires_before_schedule");
    const job = (await t.enqueue({ ...sendBody, attachments })).body.job;
    const remove = () => t.h.request(`/api/v1/outbox-attachments/${asset.id}`, { method: "DELETE", cookie: t.alice.cookie, body: {} });
    assert.equal((await remove()).body.error.code, "outbox_attachment_in_use");
    await t.tick(); await t.tick(); assert.equal(sendCalls(t.f).length, 1);
    assert.deepEqual(new Uint8Array(Buffer.from(sendCalls(t.f)[0].body.attachments[0].content, "base64")), assetBytes);
    assert.equal((await t.get(job.id)).body.job.state, "accepted"); assert.equal((await remove()).status, 200);
  } finally { await t.close(); }
});

test("expiry is not extended by queuing; failed intent releases pin and never sends", async () => {
  const t = await queueFixture();
  try {
    const asset = await t.upload(), job = (await t.enqueue({ ...sendBody, attachments: [assetRef(asset)] })).body.job;
    await t.h.db.prepare("UPDATE outbox_assets SET expires_at=unixepoch()-1 WHERE id=?").bind(asset.id).run();
    await t.h.scheduled(); assert.equal((await (await t.h.bucket()).list()).objects.length, 1, "active intent still owns the object until preparation settles");
    await t.tick(); assert.equal((await t.get(job.id)).body.job.state, "failed"); assert.equal(sendCalls(t.f).length, 0);
    await t.h.scheduled(); assert.equal((await (await t.h.bucket()).list()).objects.length, 0);
  } finally { await t.close(); }
});
