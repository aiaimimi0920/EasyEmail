import assert from "node:assert/strict";
import { test } from "node:test";
import { folderReplyFixture } from "./normal-folder-reply-fixture.mjs";
import { mailInput } from "./normal-send-fixture.mjs";

for (const race of ["reply-folder-generation", "reply-folder-catalog", "reply-folder-selectable", "reply-folder-batch", "reply-hash", "reply-session"]) {
  test(`folder preview rechecks ${race} after its asynchronous verified raw read`, async () => {
    const t = await folderReplyFixture();
    try {
      const source = await t.seedFolder();
      const result = await t.h.request(`${source.path}/reply`, { cookie: t.alice.cookie,
        headers: { "x-test-smtp-race": race, "x-test-reply-raw-race": "1" } });
      assert.equal(result.status, 409, result.text); assert.equal(result.body.error.code, "normal_account_changed"); assert.equal(t.opens.length, 0);
    } finally { await t.close(); }
  });
}

test("global folder reply UUID pins the original during draft, queued intent and pending SMTP without schema additions", async () => {
  const t = await folderReplyFixture(); let gate, sending;
  try {
    await t.configure(); const source = await t.seedFolder(), draftId = crypto.randomUUID();
    await t.h.db.prepare("INSERT INTO platform_admins(user_id,created_at) VALUES (?,1)").bind(t.alice.id).run();
    await t.h.db.exec("UPDATE retention_policy SET enabled=1,cache_days=1,trash_days=0,outgoing_days=0,audit_days=0");
    const preview = async () => {
      const policy = await t.h.request("/api/v1/admin/retention", { cookie: t.alice.cookie });
      const result = await t.h.request("/api/v1/admin/retention/preview", { cookie: t.alice.cookie, method: "POST",
        body: { expectedRevision: policy.body.revision, policy: policy.body.policy } });
      assert.equal(result.status, 200, result.text); return result.body.preview.counts.purgedNormalMessages;
    };
    assert.equal(await preview(), 1);
    const draft = { expectedRevision: 0, accountRevision: 1, to: mailInput.to, subject: mailInput.subject, text: mailInput.text, replyToMessageId: source.id };
    assert.equal((await t.h.request(`${t.path}/drafts/${draftId}`, { cookie: t.alice.cookie, method: "PUT", body: draft })).status, 201);
    assert.equal(await preview(), 0);
    const body = { ...mailInput, replyToMessageId: source.id, draftId, draftRevision: 1 }, queued = await t.enqueue(body);
    assert.equal(queued.status, 201, queued.text); assert.equal(await preview(), 0);
    await t.h.restart(); assert.equal(await preview(), 0); gate = t.hold(); sending = t.tick(); await gate.entered;
    assert.equal(await preview(), 0); assert.equal(await t.h.db.prepare("SELECT state FROM normal_outgoing_messages").first("state"), "pending");
    gate.release(); await sending; sending = null;
    assert.equal(await preview(), 1); assert.equal(t.messages.length, 1);
    assert.deepEqual((await t.h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { gate?.release(); if (sending) await sending; await t.close(); }
});
