import assert from "node:assert/strict";
import { test } from "node:test";
import { normalFlagsFixture } from "./normal-flags-access-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";

test("explicit remote flags are durable, replay-only, independently cached and never alter platform state", async () => {
  const t = await normalFlagsFixture(), key = crypto.randomUUID();
  try {
    const original = (await t.message(t.item.id)).body.message;
    assert.equal(original.accountRevision, 1); assert.equal((await t.latest()).body.operation, null);
    const result = await t.write(key); assert.equal(result.status, 201, result.text);
    assert.equal(result.body.operation.state, "confirmed"); assert.equal(result.body.operation.retrySafe, false);
    assert.deepEqual(result.body.operation.remoteFlags, ["\\Seen", "\\Flagged"]);
    const next = (await t.message(t.item.id)).body.message;
    assert.deepEqual(next.platformState, original.platformState); assert.deepEqual(next.remoteFlags, ["\\Seen", "\\Flagged"]);
    const opens = t.opens.length; await t.h.restart();
    assert.deepEqual((await t.write(key)).body.operation, result.body.operation);
    assert.deepEqual((await t.operation(key)).body.operation, result.body.operation);
    assert.deepEqual((await t.latest()).body.operation, result.body.operation); assert.equal(t.opens.length, opens);
    assert.equal((await t.write(key, { value: false })).status, 409); assert.equal(t.opens.length, opens);
    assert.equal(t.calls.filter(line => / STORE /.test(line)).length, 1);
    assert.deepEqual((await t.h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await t.close(); }
});
test("remote writes require a new scope, strict request, same origin and current owner/source", async () => {
  const t = await normalFlagsFixture();
  try {
    const opens = t.opens.length;
    for (const scopes of [["mail-accounts:read", "messages:read", "messages:write"], ["mail-accounts:remote-flags"],
      ["mail-accounts:read", "mail-accounts:remote-flags"], ["messages:read", "mail-accounts:remote-flags"]]) {
      const key = await newKey(t.h, t.alice.cookie, { scopes });
      assert.equal((await t.write(crypto.randomUUID(), {}, { token: key.token, cookie: undefined })).status, 403);
      assert.equal((await t.latest({ token: key.token, cookie: undefined })).status, 403);
    }
    assert.equal((await t.write(crypto.randomUUID(), {}, { origin: "https://evil.invalid" })).status, 403);
    assert.equal((await t.write(crypto.randomUUID(), {}, { headers: {} })).status, 400);
    for (const fields of [{ flag: "\\Deleted" }, { value: 1 }, { uid: 7 }, { expectedRevision: 0 }, { epochId: crypto.randomUUID() }])
      assert.ok([400, 409].includes((await t.write(crypto.randomUUID(), fields)).status));
    const bob = await t.h.register("remote-flags-bob"); assert.equal((await t.write(crypto.randomUUID(), {}, { cookie: bob.cookie })).status, 404);
    assert.equal(t.opens.length, opens);
    const key = await newKey(t.h, t.alice.cookie, { scopes: ["mail-accounts:read", "messages:read", "mail-accounts:remote-flags"] });
    assert.equal((await t.write(crypto.randomUUID(), {}, { token: key.token, cookie: undefined, origin: null })).body.operation.state, "confirmed");
  } finally { await t.close(); }
});
test("an unconfirmed dispatched STORE stays unknown and a new intent requires exact explicit acknowledgement", async () => {
  const t = await normalFlagsFixture(), key = crypto.randomUUID();
  try {
    t.scenario({ storeResponse: tag => `${tag} NO private-upstream-refusal\r\n` });
    const result = await t.write(key); assert.equal(result.status, 202, result.text); assert.equal(result.body.operation.state, "unknown");
    assert.ok(result.body.operation.dispatchedAt); assert.equal(result.text.includes("private-upstream-refusal"), false);
    const opens = t.opens.length; await t.write(key); await t.operation(key); assert.equal(t.opens.length, opens);
    assert.equal((await t.write()).status, 409); assert.equal((await t.write(crypto.randomUUID(), { acknowledgedUnknownId: crypto.randomUUID() })).status, 409);
    t.scenario({});
    const confirmed = await t.write(crypto.randomUUID(), { acknowledgedUnknownId: result.body.operation.id });
    assert.equal(confirmed.body.operation.state, "confirmed", confirmed.text);
    assert.equal((await t.operation(key)).body.operation.state, "unknown");
    assert.equal(t.calls.filter(line => / STORE /.test(line)).length, 2);
  } finally { await t.close(); }
});
test("concurrent requests cannot share a target; a changed account at final fence sends no STORE", async () => {
  const t = await normalFlagsFixture(), key = crypto.randomUUID(); let gate;
  try {
    gate = t.holdCommand(/ SELECT INBOX$/); const pending = t.write(key); await gate.entered;
    assert.equal((await t.write()).status, 409); assert.equal((await t.write(key)).body.operation.state, "pending");
    assert.equal((await t.save({ displayName: "edited" }, 1)).status, 200);
    gate.release(); gate = null; const result = await pending;
    assert.equal(result.body.operation.state, "failed", result.text); assert.equal(result.body.operation.dispatchedAt, null);
    assert.equal(t.calls.some(line => / STORE /.test(line)), false);
    const opens = t.opens.length; assert.equal((await t.write(key)).body.operation.state, "failed"); assert.equal(t.opens.length, opens);
  } finally { gate?.release(); await t.close(); }
});
test("stale pending receipts are unknown, preserve the original key, and require acknowledgement before another write", async () => {
  const t = await normalFlagsFixture(), key = crypto.randomUUID(); let gate;
  try {
    gate = t.holdCommand(/ SELECT INBOX$/); const pending = t.write(key); await gate.entered;
    await t.h.db.prepare("UPDATE normal_remote_flag_operations SET created_at=created_at-120 WHERE request_key=?").bind(key).run();
    assert.equal((await t.operation(key)).body.operation.state, "unknown");
    assert.equal((await t.write()).status, 409);
    gate.release(); gate = null; assert.equal((await pending).body.operation.state, "failed");
    assert.equal(t.calls.some(line => / STORE /.test(line)), false);
  } finally { gate?.release(); await t.close(); }
});
