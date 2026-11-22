import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { mutationOperationFixture } from "./normal-mutation-operation-fixture.mjs";

test("concurrent keys, flag writes and same-key replay never share a reserved source", async () => {
  const t = await mutationOperationFixture(), key = crypto.randomUUID(); let gate, pending;
  try {
    gate = t.holdCommand(/ SELECT "Sent"$/); pending = t.mutate(key); await gate.entered;
    const opens = t.opens.length, replay = await t.mutate(key);
    assert.equal(replay.body.operation.state, "pending", replay.text);
    assert.equal((await t.mutate()).status, 409); assert.equal((await t.flag()).status, 409); assert.equal(t.opens.length, opens);
    gate.release(); gate = null; assert.equal((await pending).body.operation.state, "confirmed"); pending = null;
    assert.equal(t.calls.filter(line => / UID MOVE /.test(line)).length, 1);
  } finally { gate?.release(); if (pending) await pending; await t.close(); }
});
test("an old dispatched STORE remains a barrier after a newer acknowledged flag confirms", async () => {
  const t = await mutationOperationFixture(), key = crypto.randomUUID(); let gate, pending;
  try {
    gate = t.holdCommand(/ UID STORE /); pending = t.flag(key); await gate.entered;
    const first = await t.h.db.prepare("SELECT * FROM normal_remote_flag_operations WHERE request_key=?").bind(key).first();
    await t.h.db.prepare("UPDATE normal_remote_flag_operations SET created_at=created_at-120 WHERE id=?").bind(first.id).run();
    const second = await t.flag(crypto.randomUUID(), { flag: "\\Seen", value: false, acknowledgedUnknownId: first.id });
    assert.equal(second.body.operation.state, "confirmed", second.text);
    const opens = t.opens.length, result = await t.mutate(); assert.equal(result.status, 409, result.text); assert.equal(t.opens.length, opens);
    gate.release(); gate = null; assert.equal((await pending).body.operation.state, "confirmed"); pending = null;
    assert.equal((await t.mutate()).body.operation.state, "confirmed");
    const cached = (await t.request(`${t.sourceBase}/messages/${t.item.id}`)).body.message;
    assert.deepEqual(cached.remoteFlags, second.body.operation.remoteFlags);
  } finally { gate?.release(); if (pending) await pending; await t.close(); }
});
test("reservation rechecks catalog atomically after the preflight and before all network work", async () => {
  const t = await mutationOperationFixture({ testEntry: "./normal-mutation-operation-test-worker.ts", bindings: { TEST_MUTATION_FAILURE: "hold-reserve" } });
  let gate, pending;
  try {
    gate = t.holdPut(); const opens = t.opens.length; pending = t.mutate(); await gate.entered;
    await t.h.db.prepare("UPDATE normal_server_folder_catalogs SET folders='[]' WHERE account_id=?").bind(t.id).run();
    gate.release(); gate = null; const result = await pending; pending = null;
    assert.equal(result.status, 409, result.text); assert.equal(t.opens.length, opens);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) FROM normal_remote_mutation_operations").first("COUNT(*)"), 0);
  } finally { gate?.release(); if (pending) await pending; await t.close(); }
});
test("a legacy flag inserted after mutation preflight is rejected by the database reservation trigger", async () => {
  const t = await mutationOperationFixture({ testEntry: "./normal-mutation-operation-test-worker.ts", bindings: { TEST_MUTATION_FAILURE: "hold-reserve" } });
  let reserve, store, mutation, flag;
  try {
    reserve = t.holdPut(); mutation = t.mutate(); await reserve.entered;
    store = t.holdCommand(/ UID STORE /); flag = t.flag(); await store.entered;
    reserve.release(); reserve = null; const result = await mutation; mutation = null;
    assert.equal(result.status, 409, result.text); assert.equal(result.body.error.code, "remote_write_target_busy");
    assert.equal(t.calls.some(line => / UID MOVE /.test(line)), false);
    store.release(); store = null; assert.equal((await flag).body.operation.state, "confirmed"); flag = null;
  } finally { reserve?.release(); store?.release(); if (mutation) await mutation; if (flag) await flag; await t.close(); }
});
for (const mode of ["hold-dispatch", "hold-after-dispatch"]) test(`absolute socket deadline during ${mode} never permits a late command`, async () => {
  const t = await mutationOperationFixture({ testEntry: "./normal-mutation-operation-test-worker.ts", bindings: { TEST_MUTATION_FAILURE: mode } });
  const key = crypto.randomUUID(); let gate, pending;
  try {
    gate = t.holdPut(); pending = t.mutate(key); await gate.entered;
    const result = await pending; pending = null;
    assert.equal(result.body.operation.state, mode === "hold-dispatch" ? "failed" : "unknown", result.text);
    assert.equal(result.body.operation.error, "imap_timeout");
    gate.release(); gate = null; await delay(100);
    assert.equal(t.calls.some(line => / UID (MOVE|COPY|STORE|EXPUNGE) /.test(line)), false);
    assert.deepEqual((await t.operation(key)).body, result.body);
    if (mode === "hold-after-dispatch") assert.equal((await t.mutate()).status, 409);
    else assert.equal((await t.mutate()).body.operation.state, "confirmed");
  } finally { gate?.release(); if (pending) await pending; await t.close(); }
});
test("durable COPYUID evidence survives a deadline during acknowledgement but never authorizes another command", async () => {
  const t = await mutationOperationFixture({ capabilities: "IMAP4rev1 AUTH=PLAIN UIDPLUS", testEntry: "./normal-mutation-operation-test-worker.ts",
    bindings: { TEST_MUTATION_FAILURE: "hold-after-observation" } });
  const key = crypto.randomUUID(); let gate, pending;
  try {
    gate = t.holdPut(); pending = t.mutate(key); await gate.entered;
    const result = await pending; pending = null; assert.equal(result.body.operation.state, "unknown", result.text);
    assert.equal(result.body.operation.phase, "copy"); assert.deepEqual(result.body.operation.destination, { uidValidity: "42", uid: 501 });
    gate.release(); gate = null; await delay(100);
    assert.deepEqual((await t.operation(key)).body, result.body);
    assert.equal(t.calls.filter(line => / UID (MOVE|COPY|STORE|EXPUNGE) /.test(line)).length, 1);
    assert.equal((await t.mutate()).status, 409);
  } finally { gate?.release(); if (pending) await pending; await t.close(); }
});
