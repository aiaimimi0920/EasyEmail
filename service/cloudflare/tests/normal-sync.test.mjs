import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { normalSyncFixture } from "./normal-sync-fixture.mjs";
import { RAW_MESSAGE } from "./normal-read-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";

test("normal receive persists private source identity, checkpoint and immutable binary objects across restart", async () => {
  const t = await normalSyncFixture();
  try {
    const result = await t.sync(); assert.equal(result.status, 200, result.text);
    assert.equal(result.body.stored, 2); assert.equal(result.body.complete, true);
    assert.deepEqual(result.body.cursor, { uidValidity: "42", afterUid: 7 });
    const rows = (await t.h.db.prepare("SELECT * FROM normal_inbox_messages ORDER BY uid").all()).results;
    assert.equal(rows.length, 2); assert.notEqual(rows[0].id, rows[1].id, "same body and Message-ID do not collapse distinct UIDs");
    assert.equal(rows[0].raw_sha256, createHash("sha256").update(RAW_MESSAGE).digest("hex"));
    const bucket = await t.h.bucket("INBOX");
    assert.deepEqual(new Uint8Array(await (await bucket.get(rows[0].raw_key)).arrayBuffer()), RAW_MESSAGE);
    const content = await (await bucket.get(rows[0].content_key)).text();
    assert.equal(createHash("sha256").update(content).digest("hex"), rows[0].content_sha256);
    assert.equal(JSON.parse(content).recipient, "alice@example.test"); assert.match(JSON.parse(content).textBody, /742951/);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM messages").first("n"), 0, "not exposed through legacy cache");
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM mailboxes").first("n"), 0, "no fabricated mailbox address");
    const oldEpoch = (await t.state()).epoch_id;
    await t.h.restart(); const repeated = await t.sync(); assert.equal(repeated.status, 200, repeated.text); assert.equal(repeated.body.stored, 0);
    assert.equal((await t.state()).epoch_id, oldEpoch);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_messages").first("n"), 2);
    const replay = await t.h.request("/__test/normal-commit", { method: "POST", cookie: t.alice.cookie, body: { batchId: result.body.batchId } });
    assert.equal(replay.status, 200, replay.text); assert.deepEqual(replay.body, result.body);
    const legacy = await newKey(t.h, t.alice.cookie, { scopes: ["messages:read", "attachments:read"] });
    assert.equal((await t.sync(1, { token: legacy.token, cookie: undefined })).status, 403);
    assert.equal((await t.h.request(`/api/v1/normal-accounts/${t.id}/sync`, { method: "POST", cookie: t.alice.cookie, body: { expectedRevision: 1 } })).status, 400, "Public sync separately requires an idempotency key");
  } finally { await t.close(); }
});

test("UID epoch changes preserve old identities and record deliberate skips with the committed checkpoint", async () => {
  const t = await normalSyncFixture();
  try {
    assert.equal((await t.sync()).status, 200); const epoch = (await t.state()).epoch_id;
    t.scenario({ validity: "43", reportedSize: 2 * 1024 * 1024 + 1 });
    const rollover = await t.sync(); assert.equal(rollover.status, 200, rollover.text); assert.equal(rollover.body.reset, true);
    assert.notEqual((await t.state()).epoch_id, epoch); assert.equal(rollover.body.stored, 0);
    assert.deepEqual(rollover.body.skipped, [{ uid: 2, reason: "message_too_large" }, { uid: 7, reason: "message_too_large" }]);
    const receipt = await t.h.db.prepare("SELECT * FROM normal_inbox_batches WHERE id=?").bind(rollover.body.batchId).first();
    assert.equal(receipt.status, "committed"); assert.deepEqual(JSON.parse(receipt.manifest).skipped, rollover.body.skipped);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_messages").first("n"), 2);
  } finally { await t.close(); }
});

test("storage failure leaves a tracked intent and never advances the durable cursor", async () => {
  const t = await normalSyncFixture();
  try {
    t.failPut(); const failed = await t.sync(); assert.equal(failed.status, 503, failed.text);
    assert.equal(failed.body.error.code, "normal_inbox_storage_failed"); assert.equal(failed.text.includes("private"), false);
    assert.equal((await t.state()).after_uid, 0); assert.equal((await t.state()).claim_token, null);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_messages").first("n"), 0);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_batches WHERE status='staged'").first("n"), 1);
    t.failPut(false); const next = await t.sync(); assert.equal(next.status, 200, next.text); assert.equal(next.body.stored, 2);
  } finally { await t.close(); }
});

test("missing private storage and MIME failure stop before committing mail or checkpoint", async () => {
  const absent = await normalSyncFixture({ noBucket: true });
  try { assert.equal((await absent.sync()).body.error.code, "normal_inbox_not_configured"); assert.equal(absent.opens.length, 0); }
  finally { await absent.close(); }
  const invalid = new TextEncoder().encode(`Subject: ${"x".repeat(270000)}\r\n\r\nbody`);
  const t = await normalSyncFixture({ messages: new Map([[1, invalid]]), uidNext: 2 });
  try {
    const failed = await t.sync(); assert.equal(failed.status, 502, failed.text); assert.equal(failed.body.error.code, "normal_mime_parse_failed");
    assert.equal((await t.state()).after_uid, 0); assert.equal((await t.state()).version, 0);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_batches").first("n"), 0);
  } finally { await t.close(); }
});
