import assert from "node:assert/strict";
import { test } from "node:test";
import { mutationOperationFixture } from "./normal-mutation-operation-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";

const writes = t => t.calls.filter(line => / UID (MOVE|COPY|STORE|EXPUNGE) /.test(line));
for (const [name, change] of [
  ["source generation", t => t.h.db.prepare("UPDATE normal_server_folder_state SET cache_generation=cache_generation+1 WHERE server_folder_id=?").bind(t.folder(t.source).id).run()],
  ["source watermark", t => t.h.db.prepare("UPDATE normal_server_folder_state SET after_uid=0 WHERE server_folder_id=?").bind(t.folder(t.source).id).run()],
  ["source validity", t => t.h.db.prepare("UPDATE normal_server_folder_state SET uid_validity='43' WHERE server_folder_id=?").bind(t.folder(t.source).id).run()],
  ["destination generation", t => t.h.db.prepare("UPDATE normal_server_folder_state SET cache_generation=cache_generation+1 WHERE server_folder_id=?").bind(t.folder(t.destination).id).run()],
  ["destination validity", t => t.h.db.prepare("UPDATE normal_server_folder_state SET uid_validity='43' WHERE server_folder_id=?").bind(t.folder(t.destination).id).run()],
  ["destination epoch", t => t.h.db.prepare("UPDATE normal_server_folder_state SET epoch_id=? WHERE server_folder_id=?").bind(crypto.randomUUID(), t.folder(t.destination).id).run()],
  ["catalog membership", t => t.h.db.prepare("UPDATE normal_server_folder_catalogs SET folders='[]' WHERE account_id=?").bind(t.id).run()],
  ["account revision", t => t.h.db.prepare("UPDATE normal_accounts SET revision=revision+1 WHERE id=?").bind(t.id).run()],
  ["source content", t => t.h.db.prepare("UPDATE normal_inbox_messages SET purged_at=unixepoch() WHERE id=?").bind(t.item.id).run()],
  ["owner status", t => t.h.db.prepare("UPDATE users SET status='disabled' WHERE id=?").bind(t.alice.id).run()],
  ["preparation age", (t, key) => t.h.db.prepare("UPDATE normal_remote_mutation_operations SET created_at=created_at-40 WHERE request_key=?").bind(key).run()],
]) test(`final ${name} fence prevents the first irreversible command`, async () => {
  const t = await mutationOperationFixture(), key = crypto.randomUUID(); let gate, pending;
  try {
    gate = t.holdCommand(/ SELECT "Sent"$/); pending = t.mutate(key); await gate.entered;
    await change(t, key); gate.release(); gate = null; const result = await pending; pending = null;
    assert.equal(result.status, 201, result.text); assert.equal(result.body.operation.state, "failed");
    assert.equal(result.body.operation.dispatchedAt, null); assert.deepEqual(writes(t), []);
    const receipt = await t.operation(key);
    if (name === "owner status") assert.equal(receipt.status, 401); else assert.equal(receipt.body.operation.state, "failed");
  } finally { gate?.release(); if (pending) await pending; await t.close(); }
});
for (const mode of ["revoke", "remove-scope"]) test(`initiating API credential ${mode} is checked again at dispatch`, async () => {
  const t = await mutationOperationFixture(); let gate, pending;
  try {
    const key = await newKey(t.h, t.alice.cookie, { scopes: ["mail-accounts:read", "messages:read", "mail-accounts:remote-move"] });
    gate = t.holdCommand(/ SELECT "Sent"$/); pending = t.mutate(crypto.randomUUID(), {}, { cookie: undefined, token: key.token }); await gate.entered;
    if (mode === "revoke") await t.h.db.prepare("UPDATE api_keys SET revoked_at=unixepoch() WHERE id=?").bind(key.id).run();
    else await t.h.db.prepare("UPDATE api_keys SET scopes='[]' WHERE id=?").bind(key.id).run();
    gate.release(); gate = null; const result = await pending; pending = null;
    assert.equal(result.body.operation.state, "failed", result.text); assert.deepEqual(writes(t), []);
  } finally { gate?.release(); if (pending) await pending; await t.close(); }
});
test("actual EXAMINE destination epoch is compared to the frozen synchronized epoch before MOVE", async () => {
  const t = await mutationOperationFixture();
  try {
    t.scenario({ examineResponse: tag => `* OK [UIDVALIDITY 43] changed\r\n${tag} OK [READ-ONLY] selected\r\n` });
    const result = await t.mutate(); assert.equal(result.body.operation.state, "failed", result.text);
    assert.equal(result.body.operation.dispatchedAt, null); assert.deepEqual(writes(t), []);
  } finally { await t.close(); }
});
for (const stage of ["copy", "mark-deleted"]) test(`a changed destination after ${stage} preserves partial facts but stops the next irreversible phase`, async () => {
  const t = await mutationOperationFixture({ capabilities: "IMAP4rev1 AUTH=PLAIN UIDPLUS" }); let gate, pending;
  try {
    gate = t.holdCommand(stage === "copy" ? / UID COPY / : / UID STORE /); pending = t.mutate(); await gate.entered;
    await t.h.db.prepare("UPDATE normal_server_folder_state SET cache_generation=cache_generation+1 WHERE server_folder_id=?").bind(t.folder(t.destination).id).run();
    gate.release(); gate = null; const result = await pending; pending = null;
    assert.equal(result.status, 202, result.text); assert.equal(result.body.operation.state, "unknown"); assert.equal(result.body.operation.phase, stage);
    assert.deepEqual(result.body.operation.destination, { uidValidity: "42", uid: 501 });
    assert.equal(writes(t).length, stage === "copy" ? 1 : 2); assert.equal((await t.remove()).status, 409);
  } finally { gate?.release(); if (pending) await pending; await t.close(); }
});
test("late native MOVE completion records truth after catalog invalidation without rewriting receive cache", async () => {
  const t = await mutationOperationFixture(); let gate, pending;
  try {
    const before = await t.sourceRows(); gate = t.holdCommand(/ UID MOVE /); pending = t.mutate(); await gate.entered;
    await t.h.db.prepare("UPDATE normal_server_folder_catalogs SET folders='[]' WHERE account_id=?").bind(t.id).run();
    gate.release(); gate = null; const result = await pending; pending = null;
    assert.equal(result.body.operation.state, "confirmed", result.text); assert.deepEqual(await t.sourceRows(), before); assert.equal(writes(t).length, 1);
  } finally { gate?.release(); if (pending) await pending; await t.close(); }
});
