import assert from "node:assert/strict";
import { test } from "node:test";
import { normalFlagsFixture } from "./normal-flags-access-fixture.mjs";
import { folderFlagsFixture } from "./normal-folder-flags-fixture.mjs";

test("0057 expands permanent guards without rewriting old hashes, sequence, states or cache", async () => {
  const t = await normalFlagsFixture({ through: "0056_normal_folder_organization.sql" });
  try {
    assert.equal((await t.write()).body.operation.state, "confirmed");
    t.scenario({ selectResponse: tag => `${tag} OK [READ-ONLY] selected\r\n` }); assert.equal((await t.write()).body.operation.state, "failed");
    t.scenario({ storeResponse: tag => `${tag} NO synthetic refusal\r\n` }); assert.equal((await t.write()).body.operation.state, "unknown");
    await t.h.db.prepare(`INSERT INTO normal_remote_flag_operations
      (id,user_id,account_id,message_id,account_revision,source_hash,epoch_id,cache_generation,uid_validity,uid,request_key,request_hash,flag,value,state,created_at)
      SELECT ?,user_id,account_id,message_id,account_revision,source_hash,epoch_id,cache_generation,uid_validity,uid,?,request_hash,flag,value,'pending',created_at
      FROM normal_remote_flag_operations ORDER BY sequence DESC LIMIT 1`).bind(crypto.randomUUID(), crypto.randomUUID()).run();
    const rows = (await t.h.db.prepare("SELECT * FROM normal_remote_flag_operations ORDER BY sequence").all()).results;
    const messages = (await t.h.db.prepare("SELECT * FROM normal_inbox_messages ORDER BY id").all()).results, state = await t.state();
    await t.h.migrate("0057_normal_folder_remote_flags.sql"); await t.h.migrate("0057_normal_folder_remote_flags.sql");
    const after = (await t.h.db.prepare("SELECT * FROM normal_remote_flag_operations ORDER BY sequence").all()).results;
    assert.deepEqual(after, rows.map(row => ({ ...row, server_folder_id: null, server_wire_name: null, catalog_source: null })));
    assert.deepEqual((await t.h.db.prepare("SELECT * FROM normal_inbox_messages ORDER BY id").all()).results, messages); assert.deepEqual(await t.state(), state);
    for (let mask = 1; mask < 7; mask++) await assert.rejects(t.h.db.prepare(
      "UPDATE normal_remote_flag_operations SET server_folder_id=?,server_wire_name=?,catalog_source=? WHERE id=?")
      .bind(mask & 1 ? "a".repeat(64) : null, mask & 2 ? "Sent" : null, mask & 4 ? "b".repeat(64) : null, rows[0].id).run());
    for (const name of ["", "INBOX", "inbox"]) await assert.rejects(t.h.db.prepare(
      "UPDATE normal_remote_flag_operations SET server_folder_id=?,server_wire_name=?,catalog_source=? WHERE id=?")
      .bind("a".repeat(64), name, "b".repeat(64), rows[0].id).run());
    assert.deepEqual((await t.h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await t.close(); }
});
test("0056 directory writes fail closed until identity columns are installed, then execute once", async () => {
  const t = await folderFlagsFixture({ through: "0056_normal_folder_organization.sql" }), key = crypto.randomUUID();
  try {
    const opens = t.opens.length, blocked = await t.write(key);
    assert.equal(blocked.status, 409, blocked.text); assert.equal(blocked.body.error.code, "remote_flags_folder_schema_required"); assert.equal(t.opens.length, opens);
    await t.h.migrate("0057_normal_folder_remote_flags.sql");
    assert.equal((await t.write(key)).body.operation.state, "confirmed"); assert.equal((await t.write(key)).body.operation.state, "confirmed");
    assert.equal(t.calls.filter(line => / STORE /.test(line)).length, 1);
  } finally { await t.close(); }
});
