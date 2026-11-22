import assert from "node:assert/strict";
import { test } from "node:test";
import { normalQueueFixture } from "./normal-queue-fixture.mjs";
import { selectGates } from "./account-race-fixture.mjs";
import { mailInput } from "./normal-send-fixture.mjs";
import { assetRef } from "./outbox-fixture.mjs";
import { normalReplyFixture } from "./normal-reply-fixture.mjs";

test("ordinary guard committed with lost receipt never dispatches SMTP or becomes retryable", async () => {
  const t = await normalQueueFixture();
  try {
    await t.configure(); const job = (await t.enqueue()).body.job;
    await t.h.restart({ TEST_QUEUE_FAULT: "guard-receipt-lost" }); await t.tick(); assert.equal(t.opens.length, 0);
    assert.equal((await t.get(job.id)).body.job.state, "pending");
    await t.h.db.exec("UPDATE normal_outgoing_messages SET created_at=unixepoch()-120"); await t.h.scheduled(); await t.h.restart(); await t.tick();
    const done = (await t.get(job.id)).body.job; assert.equal(done.state, "unknown"); assert.equal(done.retrySafe, false);
    assert.equal((await t.action(done, "cancel")).status, 409); assert.equal((await t.action(done, "retry")).status, 409); assert.equal(t.opens.length, 0);
  } finally { await t.close(); }
});
for (const mutation of ["cancel", "stale-claim", "account", "smtp", "user", "asset"]) {
  test(`ordinary final reservation fence rejects ${mutation} after the preparation snapshot`, async () => {
    const t = await normalQueueFixture(), gates = await selectGates(), gate = gates.hold("reservation", "unused"); let tick;
    try {
      await t.configure(); const a = await t.upload(), job = (await t.enqueue({ ...mailInput, attachments: [assetRef(a)] })).body.job;
      await t.h.restart({ TEST_QUEUE_GATE: `${gates.bindings.TEST_SELECT_GATE}/reservation` }); tick = t.tick(); await gate.entered();
      if (mutation === "cancel") assert.equal((await t.action((await t.get(job.id)).body.job, "cancel")).body.job.state, "cancelled");
      if (mutation === "stale-claim") await t.h.db.prepare("UPDATE normal_send_jobs SET claim_token=?,lease_until=unixepoch()+120 WHERE id=?").bind(crypto.randomUUID(), job.id).run();
      if (mutation === "account") await t.h.db.prepare("UPDATE normal_accounts SET revision=revision+1 WHERE id=?").bind(t.id).run();
      if (mutation === "smtp") await t.h.db.prepare("UPDATE normal_smtp_configs SET revision=revision+1 WHERE account_id=?").bind(t.id).run();
      if (mutation === "user") await t.h.db.prepare("UPDATE users SET status='disabled' WHERE id=?").bind(t.alice.id).run();
      if (mutation === "asset") await t.h.db.prepare("UPDATE outbox_assets SET version='changed' WHERE id=?").bind(a.id).run();
      gate.release(); await tick; tick = null; assert.equal(t.opens.length, 0);
      assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_outgoing_messages").first("n"), 0);
      if (mutation === "stale-claim") {
        await t.h.restart({ TEST_QUEUE_GATE: "" }); await t.h.db.prepare("UPDATE normal_send_jobs SET lease_until=unixepoch()-1 WHERE id=?").bind(job.id).run();
        await t.tick(); await t.tick(); assert.equal(t.messages.length, 1);
      }
    } finally { gate.release(); if (tick) await tick; await t.close(); await gates.close(); }
  });
}
test("ordinary queued content freezes account and SMTP revisions instead of sending through later configuration", async () => {
  const t = await normalQueueFixture();
  try {
    await t.configure(); const job = (await t.enqueue()).body.job;
    await t.h.db.prepare("UPDATE normal_smtp_configs SET revision=2 WHERE account_id=?").bind(t.id).run(); await t.tick();
    const failed = (await t.get(job.id)).body.job; assert.equal(failed.state, "failed"); assert.equal(failed.error, "smtp_config_changed"); assert.equal(t.opens.length, 0);
    // A manual retry is only a preparation retry; it cannot silently replace the frozen revision.
    assert.equal((await t.action(failed, "retry")).status, 200); await t.tick(); assert.equal(t.opens.length, 0);
  } finally { await t.close(); }
});
for (const mode of ["normal", "final-reject", "drop-final"]) {
  test(`ordinary queued SMTP ${mode} establishes a permanent no-repeat outgoing guard`, async () => {
    const t = await normalQueueFixture();
    try {
      await t.configure(); t.mode(mode); const job = (await t.enqueue()).body.job; await t.tick(); await t.h.restart(); await t.tick();
      const done = (await t.get(job.id)).body.job; assert.equal(done.state, { normal: "accepted", "final-reject": "rejected", "drop-final": "unknown" }[mode]);
      assert.equal(done.retrySafe, false); assert.equal((await t.action(done, "retry")).status, 409); assert.equal(t.messages.length, 1);
    } finally { await t.close(); }
  });
}
test("ordinary enqueue rechecks account, SMTP, draft and asset snapshots before atomic intent and draft consumption", async () => {
  const t = await normalQueueFixture();
  try {
    await t.configure(); const config = await t.h.db.prepare("SELECT * FROM normal_smtp_configs WHERE account_id=?").bind(t.id).first();
    for (const race of ["account", "deleted", "disabled", "smtp", "secret", "source", "user", "draft-edit", "draft-delete", "asset-delete", "asset-expire", "asset-version"]) {
      await t.h.db.exec("UPDATE outbox_assets SET created_at=unixepoch()-61");
      const a = await t.upload(), draft = crypto.randomUUID(); assert.equal((await t.save(draft, [assetRef(a)])).status, 201);
      const result = await t.enqueue({ ...mailInput, attachments: [assetRef(a)], draftId: draft, draftRevision: 1 }, crypto.randomUUID(), { headers: { "idempotency-key": crypto.randomUUID(), "x-test-smtp-race": race } });
      assert.ok(result.status >= 400, `${race}: ${result.text}`);
      assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_send_jobs").first("n"), 0, race);
      assert.notEqual(await t.h.db.prepare("SELECT state FROM drafts WHERE id=?").bind(draft).first("state"), "submitted", race);
      await t.h.db.prepare("UPDATE users SET status='active' WHERE id=?").bind(t.alice.id).run();
      await t.h.db.prepare("UPDATE normal_accounts SET revision=1,deleted_at=NULL,enabled=1 WHERE id=?").bind(t.id).run();
      await t.h.db.prepare("UPDATE normal_smtp_configs SET revision=1,credential_cipher=?,endpoint_hash=? WHERE account_id=?").bind(config.credential_cipher, config.endpoint_hash, t.id).run();
      await t.h.resetLimits();
    }
    assert.equal(t.opens.length, 0);
  } finally { await t.close(); }
});
test("ordinary queued reply refuses a source changed between verified reply snapshot and enqueue transaction", async () => {
  const t = await normalReplyFixture();
  try {
    await t.configure(); const source = await t.seed();
    const result = await t.h.request(`${t.path}/send-jobs`, { method: "POST", cookie: t.alice.cookie,
      headers: { "idempotency-key": crypto.randomUUID(), "x-test-smtp-race": "reply-epoch" }, body: { ...mailInput, replyToMessageId: source.id } });
    assert.ok(result.status >= 400, result.text); assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_send_jobs").first("n"), 0); assert.equal(t.opens.length, 0);
  } finally { await t.close(); }
});
