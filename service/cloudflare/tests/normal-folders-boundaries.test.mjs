import assert from "node:assert/strict";
import { test } from "node:test";
import { normalFoldersFixture } from "./normal-folders-fixture.mjs";

test("a stale LIST cannot publish or release a successor discovery lease", async () => {
  const t = await normalFoldersFixture(); let gate;
  try {
    gate = t.holdCommand(/ LIST /); const pending = t.discover(); await gate.entered;
    await t.h.db.prepare("UPDATE normal_server_folder_catalogs SET claim_lease_until=unixepoch()-1 WHERE account_id=?").bind(t.id).run();
    t.scenario({ rows: ['* LIST () "/" INBOX\r\n', '* LIST (\\Trash) "/" Trash\r\n'] });
    const successor = await t.discover(); assert.equal(successor.status, 200, successor.text);
    gate.release(); gate = null; assert.equal((await pending).status, 409);
    assert.deepEqual((await t.cached()).body.catalog, successor.body.catalog);
    assert.equal((await t.h.db.prepare("SELECT claim_token FROM normal_server_folder_catalogs WHERE account_id=?").bind(t.id).first()).claim_token, null);
  } finally { gate?.release(); await t.close(); }
});
test("account revision changes and owner disabling block publication without erasing previous complete data", async () => {
  for (const change of [async t => t.save({ displayName: "Changed name" }, 1),
    async t => t.h.db.prepare("UPDATE users SET status='disabled' WHERE id=?").bind(t.alice.id).run()]) {
    const t = await normalFoldersFixture(); let gate;
    try {
      const first = (await t.discover()).body.catalog;
      gate = t.holdCommand(/ LIST /); const pending = t.discover(); await gate.entered; await change(t);
      gate.release(); gate = null; assert.equal((await pending).status, 409);
      const stored = await t.h.db.prepare("SELECT snapshot_id,folders FROM normal_server_folder_catalogs WHERE account_id=?").bind(t.id).first();
      assert.equal(stored.snapshot_id, first.snapshotId); assert.deepEqual(JSON.parse(stored.folders), first.items);
    } finally { gate?.release(); await t.close(); }
  }
});
test("deletion during LIST hides the directory and prevents late publication", async () => {
  const t = await normalFoldersFixture(); let gate;
  try {
    gate = t.holdCommand(/ LIST /); const pending = t.discover(); await gate.entered;
    assert.equal((await t.h.request(`/api/v1/normal-accounts/${t.id}`, { method: "DELETE", cookie: t.alice.cookie,
      headers: { "idempotency-key": crypto.randomUUID() }, body: { expectedRevision: 1 } })).status, 200);
    gate.release(); gate = null; assert.equal((await pending).status, 409); assert.equal((await t.cached()).status, 404);
    assert.equal((await t.h.db.prepare("SELECT snapshot_id FROM normal_server_folder_catalogs WHERE account_id=?").bind(t.id).first()).snapshot_id, null);
  } finally { gate?.release(); await t.close(); }
});
