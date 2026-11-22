import assert from "node:assert/strict";
import { test } from "node:test";
import { mutationOperationFixture } from "./normal-mutation-operation-fixture.mjs";

const copyMutation = (t, state = "pending") => t.h.db.prepare(`INSERT INTO normal_remote_mutation_operations
  (id,user_id,account_id,message_id,account_revision,source_hash,epoch_id,cache_generation,uid_validity,uid,
    server_folder_id,server_wire_name,catalog_source,request_key,request_hash,action,state,created_at)
  SELECT ?,user_id,account_id,message_id,account_revision,source_hash,epoch_id,cache_generation,uid_validity,uid,
    server_folder_id,server_wire_name,catalog_source,?,request_hash,'delete',?,unixepoch()
  FROM normal_remote_flag_operations ORDER BY sequence DESC LIMIT 1`).bind(crypto.randomUUID(), crypto.randomUUID(), state).run();
const copyFlag = (t, state = "pending") => t.h.db.prepare(`INSERT INTO normal_remote_flag_operations
  (id,user_id,account_id,message_id,account_revision,source_hash,epoch_id,cache_generation,uid_validity,uid,
    server_folder_id,server_wire_name,catalog_source,request_key,request_hash,flag,value,state,created_at)
  SELECT ?,user_id,account_id,message_id,account_revision,source_hash,epoch_id,cache_generation,uid_validity,uid,
    server_folder_id,server_wire_name,catalog_source,?,request_hash,flag,value,?,unixepoch()
  FROM normal_remote_flag_operations ORDER BY sequence DESC LIMIT 1`).bind(crypto.randomUUID(), crypto.randomUUID(), state).run();

test("0058 preserves all historical flags, cache and checkpoints and missing schema fails before any socket", async () => {
  const t = await mutationOperationFixture({ through: "0057_normal_folder_remote_flags.sql" });
  try {
    assert.equal((await t.flag()).body.operation.state, "confirmed");
    for (const state of ["failed", "unknown", "pending"]) await copyFlag(t, state);
    const flags = (await t.h.db.prepare("SELECT * FROM normal_remote_flag_operations ORDER BY sequence").all()).results;
    const messages = await t.sourceRows(), state = await t.state();
    const folders = (await t.h.db.prepare("SELECT * FROM normal_server_folder_state ORDER BY server_folder_id").all()).results;
    const opens = t.opens.length, blocked = await t.mutate();
    assert.equal(blocked.status, 409, blocked.text); assert.equal(blocked.body.error.code, "remote_mutation_schema_required"); assert.equal(t.opens.length, opens);
    await t.h.migrate(); await t.h.migrate();
    assert.deepEqual((await t.h.db.prepare("SELECT * FROM normal_remote_flag_operations ORDER BY sequence").all()).results, flags);
    assert.deepEqual(await t.sourceRows(), messages); assert.deepEqual(await t.state(), state);
    assert.deepEqual((await t.h.db.prepare("SELECT * FROM normal_server_folder_state ORDER BY server_folder_id").all()).results, folders);
    assert.deepEqual((await t.h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
    assert.equal((await t.mutate()).status, 409); assert.equal(t.opens.length, opens);
  } finally { await t.close(); }
});
test("confirmed facts cannot bypass SQL CHECK with a NULL method or incomplete phase", async () => {
  const t = await mutationOperationFixture();
  try {
    assert.equal((await t.flag()).body.operation.state, "confirmed"); await copyMutation(t);
    for (const method of [null, "move", "copy-expunge"]) await assert.rejects(t.h.db.prepare(`UPDATE normal_remote_mutation_operations
      SET state='confirmed',phase='expunge',dispatched_at=unixepoch(),phase_at=unixepoch(),finished_at=unixepoch(),source_removed=1,method=?`).bind(method).run());
    await assert.rejects(t.h.db.prepare("UPDATE normal_remote_mutation_operations SET phase='expunge',phase_at=unixepoch()").run());
    await t.h.db.prepare(`UPDATE normal_remote_mutation_operations SET state='confirmed',phase='expunge',method='delete',
      dispatched_at=unixepoch(),phase_at=unixepoch(),finished_at=unixepoch(),source_removed=1`).run();
    await assert.rejects(t.h.db.prepare("UPDATE normal_remote_mutation_operations SET state='failed'").run());
    await assert.rejects(copyMutation(t));
  } finally { await t.close(); }
});
test("database fences reject old flags INSERT and dispatch without requiring new application code", async () => {
  const t = await mutationOperationFixture();
  try {
    const flag = await t.flag(); assert.equal(flag.body.operation.state, "confirmed");
    await copyFlag(t, "failed"); await copyMutation(t);
    await assert.rejects(copyFlag(t), /remote_write_target_busy/);
    await assert.rejects(t.h.db.prepare(`UPDATE normal_remote_flag_operations SET state='pending',dispatched_at=unixepoch()
      WHERE state='failed'`).run(), /remote_write_target_busy/);
    // An old completion records historical truth, but does not release the independent mutation lock.
    await t.h.db.prepare("UPDATE normal_remote_flag_operations SET state='pending' WHERE id=?").bind(flag.body.operation.id).run();
    await t.h.db.prepare("UPDATE normal_remote_flag_operations SET state='confirmed' WHERE id=?").bind(flag.body.operation.id).run();
    await assert.rejects(copyFlag(t), /remote_write_target_busy/);
    assert.equal((await t.mutate()).status, 409);
  } finally { await t.close(); }
});
for (const unresolved of ["pending", "unknown"]) test(`a newer confirmed flag never hides an older ${unresolved} physical-target lock`, async () => {
  const t = await mutationOperationFixture();
  try {
    const first = await t.flag(); assert.equal(first.body.operation.state, "confirmed");
    await t.h.db.prepare("UPDATE normal_remote_flag_operations SET state=?,created_at=created_at-120 WHERE id=?").bind(unresolved, first.body.operation.id).run();
    assert.equal((await t.flag(crypto.randomUUID(), { acknowledgedUnknownId: first.body.operation.id })).body.operation.state, "confirmed");
    const opens = t.opens.length;
    await assert.rejects(copyMutation(t), /remote_write_target_busy/);
    const blocked = await t.mutate(); assert.equal(blocked.status, 409, blocked.text); assert.equal(blocked.body.error.code, "remote_write_target_busy");
    assert.equal(t.opens.length, opens);
    if (unresolved === "pending") {
      await t.h.db.prepare("UPDATE normal_remote_flag_operations SET state='confirmed' WHERE id=?").bind(first.body.operation.id).run();
      assert.equal((await t.mutate()).body.operation.state, "confirmed");
    }
  } finally { await t.close(); }
});
