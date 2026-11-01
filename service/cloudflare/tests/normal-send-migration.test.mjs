import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "./runtime-harness.mjs";
import { normalSendFixture, smtpInput, mailInput } from "./normal-send-fixture.mjs";

test("30-to-31 schema expansion preserves ordinary accounts and enforces composite credential/outgoing ownership", async () => {
  const h = await createHarness({}, false, "0030_normal_subscriptions.sql");
  try {
    const alice = await h.register("smtp-migration-alice"), bob = await h.register("smtp-migration-bob"), id = crypto.randomUUID();
    await h.db.prepare(`INSERT INTO normal_accounts(id,user_id,email_address,display_name,endpoint_id,endpoint_hash,username,enabled,revision,created_at,updated_at)
      VALUES (?,?,'old@example.test','old','example','hash','old',0,1,1,1)`).bind(id, alice.id).run();
    const before = (await h.db.prepare("SELECT * FROM normal_accounts").all()).results; await h.migrate("0037_normal_sync_capacity.sql"); await h.migrate("0037_normal_sync_capacity.sql");
    assert.deepEqual((await h.db.prepare("SELECT * FROM normal_accounts").all()).results, before);
    await assert.rejects(h.db.prepare(`INSERT INTO normal_smtp_configs(account_id,user_id,account_revision,revision,endpoint_id,endpoint_hash,username,enabled,updated_at)
      VALUES (?,?,1,1,'example','hash','wrong',0,1)`).bind(id, bob.id).run(), /FOREIGN KEY/);
    assert.deepEqual((await h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM normal_outgoing_messages").first("n"), 0);
  } finally { await h.close(); }
});

test("outgoing retention redacts ordinary content but preserves quota and permanent replay guards; forgetting IMAP also erases SMTP", async () => {
  const t = await normalSendFixture();
  try {
    await t.configure(); const key = crypto.randomUUID(); await t.send(mailInput, key);
    await t.h.db.prepare("UPDATE normal_outgoing_messages SET updated_at=1").run();
    await t.h.db.prepare("UPDATE retention_policy SET enabled=1,outgoing_days=1,revision=revision+1").run();
    await t.h.scheduled();
    const row = await t.h.db.prepare("SELECT * FROM normal_outgoing_messages").first(); assert.ok(row.content_purged_at); assert.equal(row.text_body, ""); assert.equal(row.subject, "");
    assert.equal(row.recipient_count, 1); assert.equal((await t.send(mailInput, key)).body.outgoing.id, row.id); assert.equal(t.messages.length, 1);
    const removed = await t.h.request(t.path, { method: "PUT", cookie: t.alice.cookie, headers: { "idempotency-key": crypto.randomUUID() },
      body: { expectedRevision: 1, emailAddress: "alice@example.test", displayName: "Forgotten", endpointId: "example", username: "Alice", enabled: false, forgetCredential: true } });
    assert.equal(removed.status, 200, removed.text);
    assert.equal((await t.h.db.prepare("SELECT credential_cipher FROM normal_smtp_configs").first()).credential_cipher, null);
    assert.equal((await t.configure({ ...smtpInput, expectedRevision: 2, smtpRevision: 2, password: undefined })).status, 409);
  } finally { await t.close(); }
});
