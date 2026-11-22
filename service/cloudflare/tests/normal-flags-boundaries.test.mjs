import assert from "node:assert/strict";
import { test } from "node:test";
import { normalFlagsFixture } from "./normal-flags-access-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";

test("revoking the initiating API key before dispatch prevents external writes", async () => {
  const t = await normalFlagsFixture(); let gate;
  try {
    const key = await newKey(t.h, t.alice.cookie, { scopes: ["mail-accounts:read", "messages:read", "mail-accounts:remote-flags"] });
    gate = t.holdCommand(/ SELECT INBOX$/);
    const pending = t.write(crypto.randomUUID(), {}, { token: key.token, cookie: undefined }); await gate.entered;
    assert.equal((await t.h.request(`/api/v1/api-keys/${key.id}`, { method: "DELETE", cookie: t.alice.cookie })).status, 200);
    gate.release(); gate = null;
    const result = await pending; assert.equal(result.body.operation.state, "failed", result.text);
    assert.equal(t.calls.some(line => / STORE /.test(line)), false);
  } finally { gate?.release(); await t.close(); }
});
test("preparation older than 30 seconds cannot dispatch into the 60-second ambiguity window", async () => {
  const t = await normalFlagsFixture(), key = crypto.randomUUID(); let gate;
  try {
    gate = t.holdCommand(/ SELECT INBOX$/); const pending = t.write(key); await gate.entered;
    await t.h.db.prepare("UPDATE normal_remote_flag_operations SET created_at=created_at-40 WHERE request_key=?").bind(key).run();
    gate.release(); gate = null; const result = await pending;
    assert.equal(result.body.operation.state, "failed", result.text); assert.equal(result.body.operation.dispatchedAt, null);
    assert.equal(t.calls.some(line => / STORE /.test(line)), false);
  } finally { gate?.release(); await t.close(); }
});
test("purging content or disabling the owner at the final fence prevents STORE", async () => {
  for (const change of [async t => t.h.db.prepare("UPDATE normal_inbox_messages SET purged_at=unixepoch() WHERE id=?").bind(t.item.id).run(),
    async t => t.h.db.prepare("UPDATE users SET status='disabled' WHERE id=?").bind(t.alice.id).run()]) {
    const t = await normalFlagsFixture(); let gate;
    try {
      gate = t.holdCommand(/ SELECT INBOX$/); const pending = t.write(); await gate.entered;
      await change(t); gate.release(); gate = null;
      assert.equal((await pending).body.operation.state, "failed"); assert.equal(t.calls.some(line => / STORE /.test(line)), false);
    } finally { gate?.release(); await t.close(); }
  }
});
test("a completed historical operation cannot replace a newer cached flag observation", async () => {
  const t = await normalFlagsFixture(), firstKey = crypto.randomUUID(); let gate;
  try {
    gate = t.holdCommand(/ UID STORE /); const pending = t.write(firstKey); await gate.entered;
    const original = (await t.operation(firstKey)).body.operation;
    await t.h.db.prepare("UPDATE normal_remote_flag_operations SET created_at=created_at-120 WHERE request_key=?").bind(firstKey).run();
    // Synthetic late completion: the second operation explicitly accepts the unresolved first outcome.
    const second = await t.write(crypto.randomUUID(), { flag: "\\Seen", value: false, acknowledgedUnknownId: original.id });
    assert.equal(second.body.operation.state, "confirmed", second.text);
    gate.release(); gate = null; assert.equal((await pending).body.operation.state, "confirmed");
    const message = (await t.message(t.item.id)).body.message;
    assert.deepEqual(message.remoteFlags, second.body.operation.remoteFlags);
    assert.equal((await t.latest()).body.operation.id, second.body.operation.id);
  } finally { gate?.release(); await t.close(); }
});
