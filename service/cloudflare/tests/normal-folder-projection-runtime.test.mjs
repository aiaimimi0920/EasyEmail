import assert from "node:assert/strict";
import { test } from "node:test";
import { folderProjectionFixture, expect } from "./normal-folder-projection-fixture.mjs";

test("folder projections enter cached search with real recipients and preserve epoch-local conversation/subscription membership", async () => {
  const t = await folderProjectionFixture();
  try {
    await t.receiveAll(); const opens = t.opens.length;
    const messages = expect(await t.list()).items; assert.equal(messages.length, 6);
    assert.equal(messages.filter(row => !row.serverFolderId).length, 2, "INBOX remains the original writable source");
    for (const wireName of ["Sent", "&Ti1lhw-"]) {
      const folder = t.folder(wireName), rows = messages.filter(row => row.serverFolderId === folder.id);
      assert.equal(rows.length, 2); assert.ok(rows.every(row => row.serverFolderName === folder.name && row.recipient === "recipient@example.test"));
      const detail = expect(await t.request(`${t.folderPath(wireName)}/messages/${rows[0].id}`)).message;
      assert.equal(detail.id, rows[0].id); assert.equal((await t.request(`${t.base}/messages/${rows[0].id}`)).status, 404);
    }
    assert.equal(expect(await t.list("messages", "recipient=recipient@example.test")).items.length, 4);
    for (const kind of ["conversations", "subscriptions"]) {
      const groups = expect(await t.list(kind)).items; assert.equal(groups.length, 3, kind);
      assert.equal(new Set(groups.map(row => row.epochId)).size, 3);
      for (const group of groups) {
        assert.equal(group.messageCount, 2); const members = expect(await t.members(kind, group)).items;
        assert.equal(members.length, 2); assert.ok(members.every(row => row.epochId === group.epochId));
        assert.ok(members.every(row => row.serverFolderId === group.latest.serverFolderId));
      }
    }
    assert.equal(t.opens.length, opens, "all aggregate readers use cached data only");
    const extraction = expect(await t.request(`${t.base}/extractions?since=1`));
    assert.ok(extraction.items.every(row => messages.filter(m => !m.serverFolderId).some(m => m.id === row.id)), "legacy extraction remains INBOX-only");
  } finally { await t.close(); }
});

test("folder subscription hidden preference is epoch-local, replay-safe and does not enable old message writes", async () => {
  const t = await folderProjectionFixture();
  try {
    await t.receiveAll(); const items = expect(await t.list("subscriptions")).items;
    const target = items.find(row => row.latest.serverFolderId === t.folder("Sent").id); assert.ok(target);
    const key = crypto.randomUUID(), first = expect(await t.hide(target, true, key));
    assert.equal(first.operation.epochId, target.epochId); assert.equal(first.operation.hidden, true);
    assert.equal(expect(await t.hide(target, true, key)).replayed, true);
    assert.equal((await t.hide(target, false, key)).status, 409);
    const visible = expect(await t.list("subscriptions")).items; assert.equal(visible.length, 2);
    const hidden = expect(await t.list("subscriptions", "visibility=hidden")).items; assert.equal(hidden.length, 1);
    assert.equal(hidden[0].epochId, target.epochId); assert.equal(expect(await t.members("subscriptions", hidden[0], "visibility=hidden")).items.length, 2);
    expect(await t.hide(hidden[0], false)); assert.equal(expect(await t.list("subscriptions")).items.length, 3);
    for (const suffix of ["reply", "remote-flags", "labels", "folder"]) {
      assert.equal((await t.request(`${t.base}/messages/${target.latest.id}/${suffix}`)).status, 404, suffix);
    }
    assert.equal(t.calls.some(line => / STORE | MOVE | EXPUNGE/.test(line)), false);
  } finally { await t.close(); }
});
