import assert from "node:assert/strict";
import { test } from "node:test";
import { normalAttachmentsFixture } from "./normal-attachments-fixture.mjs";
import { assetRef } from "./outbox-fixture.mjs";
import { mailInput } from "./normal-send-fixture.mjs";

test("ordinary send and draft final SQL fences reject attachments changed after byte/reference validation", async () => {
  for (const race of ["asset-delete", "asset-expire", "asset-version"]) {
    const t = await normalAttachmentsFixture();
    try {
      await t.configure(); const a = await t.upload(), attachments = [assetRef(a)], id = crypto.randomUUID();
      assert.equal((await t.save(id, attachments)).status, 201);
      const result = await t.send({ ...mailInput, attachments, draftId: id, draftRevision: 1 }, crypto.randomUUID(), { headers: { "x-test-smtp-race": race, "idempotency-key": crypto.randomUUID() } });
      assert.equal(result.status, 409, result.text); assert.equal(t.opens.length, 0);
      assert.equal(await t.h.db.prepare("SELECT state FROM drafts WHERE id=?").bind(id).first("state"), "editing");
      assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_outgoing_messages").first("n"), 0);
      const b = await t.upload(); const save = await t.save(crypto.randomUUID(), [assetRef(b)], {}, { headers: { "x-test-smtp-race": race } });
      assert.equal(save.status, 409, save.text);
    } finally { await t.close(); }
  }
});

test("normal pending manifest pins deletion/expiry/inventory and concurrent draft send consumes once", async () => {
  const t = await normalAttachmentsFixture(); let pending, gate;
  try {
    await t.configure(); const a = await t.upload(), attachments = [assetRef(a)], id = crypto.randomUUID(); assert.equal((await t.save(id, attachments)).status, 201);
    const input = { ...mailInput, attachments, draftId: id, draftRevision: 1 }; gate = t.hold(); pending = t.send(input);
    await gate.entered;
    assert.equal((await t.remove(a.id)).body.error.code, "outbox_attachment_in_use");
    await t.h.db.prepare("UPDATE outbox_assets SET expires_at=1 WHERE id=?").bind(a.id).run(); await t.h.scheduled();
    const row = await t.h.db.prepare("SELECT * FROM outbox_assets WHERE id=?").bind(a.id).first(); assert.equal(row.state, "ready"); assert.ok(await (await t.h.bucket()).get(row.object_key));
    assert.equal((await t.send(input)).body.error.code, "draft_submitted"); assert.equal(t.opens.length, 1);
    gate.release(); assert.equal((await pending).status, 201); pending = null; await t.h.scheduled();
    assert.equal((await t.h.db.prepare("SELECT state FROM outbox_assets WHERE id=?").bind(a.id).first()).state, "expired");
    assert.equal(await (await t.h.bucket()).get(row.object_key), null); assert.equal(t.messages.length, 1);
  } finally { gate?.release(); await pending?.catch(() => {}); await t.close(); }
});

test("multipart DATA ambiguity and finish-write failure retain one durable consumed guard after asset cleanup", async () => {
  for (const fault of ["drop-final", "finish-write"]) {
    const t = await normalAttachmentsFixture();
    try {
      await t.configure(); const a = await t.upload(), attachments = [assetRef(a)], id = crypto.randomUUID(), key = crypto.randomUUID();
      assert.equal((await t.save(id, attachments)).status, 201); const input = { ...mailInput, attachments, draftId: id, draftRevision: 1 };
      if (fault === "drop-final") t.mode(fault);
      const result = await t.send(input, key, fault === "finish-write" ? { headers: { "idempotency-key": key, "x-test-smtp-finish-failure": "1" } } : {});
      assert.equal(result.status, 202, result.text); assert.equal(result.body.outgoing.state, "unknown");
      await t.h.db.prepare("UPDATE normal_outgoing_messages SET created_at=1").run(); await t.h.scheduled(); assert.equal((await t.remove(a.id)).status, 200);
      await t.h.restart(); const replay = await t.send(input, key); assert.equal(replay.status, 202); assert.equal(t.messages.length, 1); assert.equal(t.opens.length, 1);
      assert.equal(await t.h.db.prepare("SELECT state FROM drafts WHERE id=?").bind(id).first("state"), "submitted");
    } finally { await t.close(); }
  }
});
