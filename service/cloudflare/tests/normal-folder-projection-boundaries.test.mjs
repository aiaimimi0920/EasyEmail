import assert from "node:assert/strict";
import { test } from "node:test";
import { folderProjectionFixture, expect } from "./normal-folder-projection-fixture.mjs";

test("folder aggregate pages are stable across catalog reorder; membership, source and epoch changes invalidate stale owners/cursors", async () => {
  const t = await folderProjectionFixture();
  try {
    await t.receiveAll(); const opens = t.opens.length;
    for (const kind of ["messages", "conversations", "subscriptions"]) {
      const items = []; let cursor = "";
      do { const page = expect(await t.list(kind, `limit=1${cursor ? `&cursor=${cursor}` : ""}`)); items.push(...page.items); cursor = page.nextCursor; } while (cursor);
      assert.equal(items.length, kind === "messages" ? 6 : 3);
      assert.equal(new Set(items.map(row => `${row.epochId}:${row.id}`)).size, items.length);
    }
    const first = expect(await t.list("messages", "limit=1")), catalog = await t.h.db.prepare("SELECT folders FROM normal_server_folder_catalogs WHERE account_id=?").bind(t.id).first("folders");
    const folders = JSON.parse(catalog);
    await t.h.db.prepare("UPDATE normal_server_folder_catalogs SET folders=? WHERE account_id=?").bind(JSON.stringify([...folders].reverse()), t.id).run();
    expect(await t.list("messages", `limit=1&cursor=${first.nextCursor}`));
    const subscription = expect(await t.list("subscriptions")).items.find(row => row.latest.serverFolderId === t.folder("Sent").id);
    await t.h.db.prepare("UPDATE normal_server_folder_catalogs SET folders=? WHERE account_id=?")
      .bind(JSON.stringify(folders.map(row => row.wireName === "Sent" ? { ...row, selectable: false } : row)), t.id).run();
    assert.equal(expect(await t.list()).items.length, 4); expect(await t.members("subscriptions", subscription), 409); expect(await t.hide(subscription), 409);
    expect(await t.list("messages", `limit=1&cursor=${first.nextCursor}`), 400);
    await t.h.db.prepare("UPDATE normal_server_folder_catalogs SET folders=? WHERE account_id=?").bind(catalog, t.id).run();
    const oldEpoch = subscription.epochId, newEpoch = crypto.randomUUID();
    await t.h.db.prepare("UPDATE normal_server_folder_state SET epoch_id=? WHERE account_id=? AND server_folder_id=?").bind(newEpoch, t.id, t.folder("Sent").id).run();
    assert.equal(expect(await t.list()).items.length, 4); expect(await t.members("subscriptions", subscription), 409);
    await t.h.db.prepare("UPDATE normal_server_folder_state SET epoch_id=? WHERE account_id=? AND server_folder_id=?").bind(oldEpoch, t.id, t.folder("Sent").id).run();
    expect(await t.save({ username: "changed-source" }, 1));
    for (const kind of ["messages", "conversations", "subscriptions"]) assert.equal(expect(await t.list(kind)).items.length, 0);
    assert.equal(t.opens.length, opens);
  } finally { await t.close(); }
});

test("aggregate visibility rejects corrupted folder/batch bindings, staged batches and purged messages without widening old writes", async () => {
  const t = await folderProjectionFixture();
  try {
    await t.receiveAll(); const folderId = t.folder("Sent").id;
    const row = await t.h.db.prepare("SELECT * FROM normal_inbox_messages WHERE server_folder_id=? LIMIT 1").bind(folderId).first();
    const batch = await t.h.db.prepare("SELECT * FROM normal_inbox_batches WHERE id=?").bind(row.batch_id).first();
    for (const [column, value] of [["source_hash", "invalid-source"], ["server_folder_id", t.folder("&Ti1lhw-").id], ["epoch_id", crypto.randomUUID()], ["status", "staged"]]) {
      await t.h.db.prepare(`UPDATE normal_inbox_batches SET ${column}=?${column === "status" ? ",committed_at=NULL" : ""} WHERE id=?`).bind(value, batch.id).run();
      for (const kind of ["messages", "conversations", "subscriptions"]) assert.ok(expect(await t.list(kind)).items.every(item => (item.latest ?? item).serverFolderId !== folderId), `${kind}:${column}`);
      await t.h.db.prepare(`UPDATE normal_inbox_batches SET ${column}=?${column === "status" ? ",committed_at=?" : ""} WHERE id=?`)
        .bind(batch[column], ...(column === "status" ? [batch.committed_at] : []), batch.id).run();
    }
    await t.h.db.prepare("UPDATE normal_inbox_messages SET server_folder_id=? WHERE id=?").bind(t.folder("&Ti1lhw-").id, row.id).run();
    assert.equal(expect(await t.list()).items.length, 5);
    await t.h.db.prepare("UPDATE normal_inbox_messages SET server_folder_id=?,purged_at=unixepoch() WHERE id=?").bind(folderId, row.id).run();
    assert.equal(expect(await t.list()).items.length, 5);
    const bob = await t.h.register("folder-projection-bob"); assert.equal(expect(await t.request("/api/v1/messages?sources=normal", { cookie: bob.cookie })).items.length, 0);
    expect(await t.request(`${t.base}/messages/${row.id}`, { cookie: bob.cookie }), 404);
    const result = await t.request(`${t.base}/messages/organize`, { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: { messageIds: [row.id], starred: true } });
    assert.notEqual(result.status, 200); assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_message_state").first("n"), 0);
    assert.deepEqual((await t.h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await t.close(); }
});
