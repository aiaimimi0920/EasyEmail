import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { folderFlagsFixture } from "./normal-folder-flags-fixture.mjs";

test("directory flags select exact folder despite identical INBOX UID and keep platform state independent", async () => {
  const t = await folderFlagsFixture(), key = crypto.randomUUID();
  try {
    await t.receive("INBOX"); await t.receive("&Ti1lhw-"); const before = (await t.message()).body.message;
    const result = await t.write(key); assert.equal(result.status, 201, result.text);
    assert.equal(result.body.operation.state, "confirmed"); assert.equal(result.body.operation.serverFolderId, t.folderId);
    const after = (await t.message()).body.message;
    assert.deepEqual(after.platformState, before.platformState); assert.deepEqual(after.remoteFlags, ["\\Seen", "\\Flagged"]);
    for (const name of ["INBOX", "&Ti1lhw-"]) assert.deepEqual((await t.messages(name)).body.items[0].remoteFlags, ["\\Seen"]);
    assert.equal(t.calls.filter(line => / SELECT "Sent"$/.test(line)).length, 1);
    assert.equal(t.calls.filter(line => / STORE /.test(line)).length, 1);
    const inbox = (await t.messages("INBOX")).body.items[0], other = (await t.messages("&Ti1lhw-")).body.items[0];
    assert.equal((await t.request(`${t.base}/messages/${t.item.id}/remote-flags`, { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: { ...t.body, epochId: inbox.epochId } })).status, 404);
    assert.equal((await t.request(`${t.folderPath("&Ti1lhw-")}/messages/${t.item.id}/remote-flags`, { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: { ...t.body, epochId: other.epochId } })).status, 404);
    assert.equal(t.calls.filter(line => / STORE /.test(line)).length, 1);
  } finally { await t.close(); }
});
test("permanent directory receipt recovers after catalog/content removal and rejects wrong-route reuse", async () => {
  const t = await folderFlagsFixture(), key = crypto.randomUUID();
  try {
    const result = await t.write(key); assert.equal(result.status, 201, result.text); const opens = t.opens.length;
    await t.h.db.prepare("UPDATE normal_server_folder_catalogs SET folders='[]' WHERE account_id=?").bind(t.id).run();
    await t.h.db.prepare("UPDATE normal_inbox_messages SET purged_at=unixepoch() WHERE id=?").bind(t.item.id).run();
    await t.h.restart(); assert.deepEqual((await t.write(key)).body.operation, result.body.operation);
    assert.deepEqual((await t.operation(key)).body.operation, result.body.operation); assert.equal(t.opens.length, opens);
    assert.equal((await t.request(`${t.base}/remote-flag-operations/${key}`)).status, 404);
    assert.equal((await t.request(`${t.base}/messages/${t.item.id}/remote-flags`, { method: "POST", headers: { "idempotency-key": key }, body: t.body })).status, 409);
    assert.equal((await t.write(key, { value: false })).status, 409);
    const row = await t.h.db.prepare("SELECT * FROM normal_remote_flag_operations WHERE request_key=?").bind(key).first();
    assert.equal(row.server_folder_id, t.folderId); assert.equal(row.server_wire_name, "Sent"); assert.equal(row.catalog_source.length, 64);
    assert.deepEqual((await t.h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await t.close(); }
});
test("legacy INBOX request hash is unchanged and directory aliases do not create a second write namespace", async () => {
  const t = await folderFlagsFixture();
  try {
    await t.receive("INBOX"); const item = (await t.messages("INBOX")).body.items[0], key = crypto.randomUUID();
    const body = { ...t.body, epochId: item.epochId }, path = `${t.base}/messages/${item.id}/remote-flags`;
    const result = await t.request(path, { method: "POST", headers: { "idempotency-key": key }, body }); assert.equal(result.status, 201, result.text);
    const row = await t.h.db.prepare("SELECT * FROM normal_remote_flag_operations WHERE request_key=?").bind(key).first();
    assert.equal(row.request_hash, createHash("sha256").update(JSON.stringify([t.id, item.id, body])).digest("hex"));
    assert.equal(row.server_folder_id, null); assert.equal(Object.hasOwn(result.body.operation, "serverFolderId"), false);
    assert.equal((await t.request(`${t.folderPath("INBOX")}/messages/${item.id}/remote-flags`, { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body })).status, 404);
    assert.equal((await t.request(`${t.folderPath("Sent")}/remote-flag-operations/${key}`)).status, 404);
  } finally { await t.close(); }
});
