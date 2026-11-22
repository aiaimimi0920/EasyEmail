import assert from "node:assert/strict";
import { test } from "node:test";
import { folderFlagsFixture } from "./normal-folder-flags-fixture.mjs";

test("directory STORE fact is recorded after catalog invalidation but stale cached flags are not published", async () => {
  const t = await folderFlagsFixture(); let gate;
  try {
    const before = await t.h.db.prepare("SELECT flags FROM normal_inbox_messages WHERE id=?").bind(t.item.id).first();
    gate = t.holdCommand(/ UID STORE /); const pending = t.write(); await gate.entered;
    await t.h.db.prepare("UPDATE normal_server_folder_catalogs SET folders='[]' WHERE account_id=?").bind(t.id).run();
    gate.release(); gate = null; const result = await pending;
    assert.equal(result.body.operation.state, "confirmed", result.text); assert.ok(result.body.operation.remoteFlags.includes("\\Flagged"));
    assert.deepEqual(await t.h.db.prepare("SELECT flags FROM normal_inbox_messages WHERE id=?").bind(t.item.id).first(), before);
    assert.equal(t.calls.filter(line => / STORE /.test(line)).length, 1);
  } finally { gate?.release(); await t.close(); }
});
for (const change of ["cache_generation=cache_generation+1", "after_uid=0", "uid_validity='43'"]) test(`confirmed directory fact cannot update cache after ${change}`, async () => {
  const t = await folderFlagsFixture(); let gate;
  try {
    const before = await t.h.db.prepare("SELECT flags FROM normal_inbox_messages WHERE id=?").bind(t.item.id).first();
    gate = t.holdCommand(/ UID STORE /); const pending = t.write(); await gate.entered;
    await t.h.db.prepare(`UPDATE normal_server_folder_state SET ${change} WHERE account_id=? AND server_folder_id=?`).bind(t.id, t.folderId).run();
    gate.release(); gate = null; const result = await pending; assert.equal(result.body.operation.state, "confirmed", result.text);
    assert.deepEqual(await t.h.db.prepare("SELECT flags FROM normal_inbox_messages WHERE id=?").bind(t.item.id).first(), before);
    assert.equal(t.calls.filter(line => / STORE /.test(line)).length, 1);
  } finally { gate?.release(); await t.close(); }
});
test("late directory execution cannot overwrite a newer acknowledged observation", async () => {
  const t = await folderFlagsFixture(), key = crypto.randomUUID(); let gate;
  try {
    gate = t.holdCommand(/ UID STORE /); const pending = t.write(key); await gate.entered;
    const old = (await t.operation(key)).body.operation;
    await t.h.db.prepare("UPDATE normal_remote_flag_operations SET created_at=created_at-120 WHERE request_key=?").bind(key).run();
    const newer = await t.write(crypto.randomUUID(), { flag: "\\Seen", value: false, acknowledgedUnknownId: old.id });
    assert.equal(newer.body.operation.state, "confirmed", newer.text);
    gate.release(); gate = null; assert.equal((await pending).body.operation.state, "confirmed");
    assert.deepEqual((await t.message()).body.message.remoteFlags, newer.body.operation.remoteFlags);
    assert.equal((await t.latest()).body.operation.id, newer.body.operation.id);
  } finally { gate?.release(); await t.close(); }
});
for (const mode of ["before-insert", "after-insert", "after-dispatch", "before-finish", "after-finish"]) test(`directory lost receipt (${mode}) never reacquires execution authority`, async () => {
  const t = await folderFlagsFixture({ testEntry: "./normal-flags-test-worker.ts", bindings: { TEST_FLAG_FAILURE: mode } }), key = crypto.randomUUID();
  try {
    const result = await t.write(key);
    if (mode === "before-insert") {
      assert.equal(result.status, 503); assert.equal((await t.operation(key)).status, 404); assert.equal(t.calls.some(line => / STORE /.test(line)), false);
      assert.equal((await t.write(key)).body.operation.state, "confirmed");
    } else {
      const state = { "after-insert": "pending", "after-dispatch": "unknown", "before-finish": "pending", "after-finish": "confirmed" }[mode];
      assert.equal(result.status, mode === "before-finish" ? 503 : mode === "after-dispatch" ? 202 : mode === "after-finish" ? 201 : 200, result.text);
      assert.equal((await t.operation(key)).body.operation.state, state);
      assert.equal(t.calls.filter(line => / STORE /.test(line)).length, ["before-finish", "after-finish"].includes(mode) ? 1 : 0);
      if (state === "pending") {
        assert.equal((await t.write()).status, 409);
        await t.h.db.prepare("UPDATE normal_remote_flag_operations SET created_at=created_at-120 WHERE request_key=?").bind(key).run();
        assert.equal((await t.operation(key)).body.operation.state, "unknown"); assert.equal((await t.write()).status, 409);
      }
    }
    const stores = t.calls.filter(line => / STORE /.test(line)).length, opens = t.opens.length;
    const receipt = (await t.operation(key)).body.operation; await t.h.restart();
    assert.deepEqual((await t.write(key)).body.operation, receipt); assert.equal(t.opens.length, opens);
    assert.equal(t.calls.filter(line => / STORE /.test(line)).length, stores);
  } finally { await t.close(); }
});
test("unknown directory operation needs exact explicit acknowledgement before another intent", async () => {
  const t = await folderFlagsFixture(), key = crypto.randomUUID();
  try {
    t.scenario({ storeResponse: tag => `${tag} NO synthetic refusal\r\n` });
    const unknown = await t.write(key); assert.equal(unknown.body.operation.state, "unknown", unknown.text);
    const opens = t.opens.length; await t.write(key); assert.equal(t.opens.length, opens);
    assert.equal((await t.write()).status, 409); assert.equal((await t.write(crypto.randomUUID(), { acknowledgedUnknownId: crypto.randomUUID() })).status, 409);
    t.scenario({}); const result = await t.write(crypto.randomUUID(), { acknowledgedUnknownId: unknown.body.operation.id });
    assert.equal(result.body.operation.state, "confirmed", result.text); assert.equal(t.calls.filter(line => / STORE /.test(line)).length, 2);
  } finally { await t.close(); }
});
