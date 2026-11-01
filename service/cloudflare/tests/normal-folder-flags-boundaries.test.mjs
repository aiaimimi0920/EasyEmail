import assert from "node:assert/strict";
import { test } from "node:test";
import { folderFlagsFixture } from "./normal-folder-flags-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";

const mutations = [
  ["catalog gone", t => t.h.db.prepare("UPDATE normal_server_folder_catalogs SET folders='[]' WHERE account_id=?").bind(t.id).run()],
  ["catalog source", t => t.h.db.prepare("UPDATE normal_server_folder_catalogs SET source_hash=? WHERE account_id=?").bind("f".repeat(64), t.id).run()],
  ["catalog wire", t => t.h.db.prepare("UPDATE normal_server_folder_catalogs SET folders=json_set(folders,'$[1].wireName','Other') WHERE account_id=?").bind(t.id).run()],
  ["catalog unselectable", t => t.h.db.prepare("UPDATE normal_server_folder_catalogs SET folders=json_set(folders,'$[1].selectable',json('false')) WHERE account_id=?").bind(t.id).run()],
  ["source changed", t => t.h.db.prepare("UPDATE normal_server_folder_state SET source_hash=? WHERE account_id=? AND server_folder_id=?").bind("f".repeat(64), t.id, t.folderId).run()],
  ["epoch changed", t => t.h.db.prepare("UPDATE normal_server_folder_state SET epoch_id=? WHERE account_id=? AND server_folder_id=?").bind(crypto.randomUUID(), t.id, t.folderId).run()],
  ["generation changed", t => t.h.db.prepare("UPDATE normal_server_folder_state SET cache_generation=cache_generation+1 WHERE account_id=? AND server_folder_id=?").bind(t.id, t.folderId).run()],
  ["watermark rewound", t => t.h.db.prepare("UPDATE normal_server_folder_state SET after_uid=0 WHERE account_id=? AND server_folder_id=?").bind(t.id, t.folderId).run()],
  ["batch moved", t => t.h.db.prepare("UPDATE normal_inbox_batches SET server_folder_id=? WHERE id=(SELECT batch_id FROM normal_inbox_messages WHERE id=?)").bind(t.folder("&Ti1lhw-").id, t.item.id).run()],
  ["UIDVALIDITY changed", t => t.h.db.prepare("UPDATE normal_inbox_messages SET uid_validity='43' WHERE id=?").bind(t.item.id).run()],
  ["state UIDVALIDITY changed", t => t.h.db.prepare("UPDATE normal_server_folder_state SET uid_validity='43' WHERE account_id=? AND server_folder_id=?").bind(t.id, t.folderId).run()],
  ["UID changed", t => t.h.db.prepare("UPDATE normal_inbox_messages SET uid=3 WHERE id=?").bind(t.item.id).run()],
  ["disabled account", t => t.h.db.prepare("UPDATE normal_accounts SET enabled=0 WHERE id=?").bind(t.id).run()],
];
for (const [name, mutate] of mutations) test(`directory dispatch fence refuses ${name} without STORE`, async () => {
  const t = await folderFlagsFixture(); let gate;
  try {
    gate = t.holdCommand(/ SELECT "Sent"$/); const pending = t.write(); await gate.entered;
    await mutate(t); gate.release(); gate = null;
    const result = await pending; assert.equal(result.body.operation.state, "failed", result.text);
    assert.equal(result.body.operation.dispatchedAt, null); assert.equal(t.calls.some(line => / STORE /.test(line)), false);
  } finally { gate?.release(); await t.close(); }
});
test("directory remote writes require all scopes, origin, exact target and live credential", async () => {
  const t = await folderFlagsFixture(); let gate;
  try {
    const opens = t.opens.length;
    for (const scopes of [["mail-accounts:read", "messages:read"], ["mail-accounts:remote-flags"], ["messages:read", "mail-accounts:remote-flags"]]) {
      const key = await newKey(t.h, t.alice.cookie, { scopes });
      assert.equal((await t.write(crypto.randomUUID(), {}, { cookie: undefined, token: key.token, origin: null })).status, 403);
      assert.equal((await t.latest({ cookie: undefined, token: key.token })).status, 403);
    }
    assert.equal((await t.write(crypto.randomUUID(), {}, { origin: "https://evil.invalid" })).status, 403);
    for (const patch of [{ uid: 2 }, { wireName: "INBOX" }, { serverFolderId: t.folderId }, { flag: "\\Deleted" }]) assert.equal((await t.write(crypto.randomUUID(), patch)).status, 400);
    const bob = await t.h.register("folder-flags-bob"); assert.equal((await t.write(crypto.randomUUID(), {}, { cookie: bob.cookie })).status, 404);
    assert.equal(t.opens.length, opens);
    const key = await newKey(t.h, t.alice.cookie, { scopes: ["mail-accounts:read", "messages:read", "mail-accounts:remote-flags"] });
    gate = t.holdCommand(/ SELECT "Sent"$/); const pending = t.write(crypto.randomUUID(), {}, { cookie: undefined, token: key.token, origin: null }); await gate.entered;
    await t.h.db.prepare("UPDATE api_keys SET revoked_at=1 WHERE id=?").bind(key.id).run(); gate.release(); gate = null;
    assert.equal((await pending).body.operation.state, "failed"); assert.equal(t.calls.some(line => / STORE /.test(line)), false);
  } finally { gate?.release(); await t.close(); }
});
for (const credential of [false, true]) test(`reservation itself rejects ${credential ? "credential revocation" : "catalog removal"} before opening a socket`, async () => {
  const t = await folderFlagsFixture({ testEntry: "./normal-flags-test-worker.ts", bindings: { TEST_FLAG_FAILURE: "hold-reserve" } }); let gate;
  try {
    const key = await newKey(t.h, t.alice.cookie, { scopes: ["mail-accounts:read", "messages:read", "mail-accounts:remote-flags"] });
    const opens = t.opens.length; gate = t.holdPut();
    const pending = t.write(crypto.randomUUID(), {}, { cookie: undefined, token: key.token, origin: null }); await gate.entered;
    if (credential) await t.h.db.prepare("UPDATE api_keys SET revoked_at=1 WHERE id=?").bind(key.id).run();
    else await mutations[0][1](t);
    gate.release(); gate = null; const result = await pending;
    assert.equal(result.status, 409, result.text); assert.equal(result.body.error.code, "remote_flags_changed_or_limit");
    assert.equal(t.opens.length, opens); assert.equal(t.calls.some(line => / STORE /.test(line)), false);
    assert.equal((await t.h.db.prepare("SELECT COUNT(*) n FROM normal_remote_flag_operations").first()).n, 0);
  } finally { gate?.release(); await t.close(); }
});
