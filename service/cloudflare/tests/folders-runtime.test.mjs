import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { foldersFixture, folderBody, folderPath, putFolder, deleteFolder, messageFolder, organize, expect } from "./folders-fixture.mjs";
import { labelBody, putLabel } from "./labels-fixture.mjs";

let f, h, alice, bob, box, ids;
before(async () => { f = await foldersFixture(); ({ h, alice, bob, box, ids } = f); });
beforeEach(async () => h.resetLimits()); after(async () => f?.close());

test("private folder hierarchy supports normalized CAS saves, rejects cycles and preserves deletion tombstones", async () => {
  const parent = crypto.randomUUID(), child = crypto.randomUUID();
  assert.equal(expect(await putFolder(h, alice, parent, folderBody("  Cafe\u0301  ")), 201).folder.name, "Café");
  expect(await putFolder(h, alice, parent, folderBody("Café")));
  expect(await putFolder(h, alice, crypto.randomUUID(), folderBody("CAFÉ")), 409);
  expect(await putFolder(h, alice, child, folderBody("子目录", parent)), 201);
  expect(await putFolder(h, alice, parent, folderBody("Café", child, 1)), 409);
  expect(await putFolder(h, alice, child, folderBody("子目录", child, 1)), 409);
  expect(await putFolder(h, alice, child, folderBody("改名", parent, 1, "green")));
  expect(await putFolder(h, alice, child, folderBody("旧改名", parent, 1)), 409);
  expect(await deleteFolder(h, alice, parent, 1)); expect(await deleteFolder(h, alice, parent, 1));
  const survivor = expect(await h.request(folderPath(), { cookie: alice.cookie })).items.find(x => x.id === child);
  assert.equal(survivor.parentId, null); assert.equal(survivor.revision, 3);
  expect(await putFolder(h, alice, child, folderBody("过期子目录", null, 2)), 409);
  expect(await putFolder(h, alice, parent), 409);
  expect(await putFolder(h, alice, crypto.randomUUID(), folderBody("Café")), 201);
  assert.equal(expect(await h.request(folderPath(), { cookie: bob.cookie })).items.length, 0);
});

test("a message has one platform location; folder moves and old archive commands preserve labels and content", async () => {
  const a = crypto.randomUUID(), b = crypto.randomUUID(), label = crypto.randomUUID();
  expect(await putFolder(h, alice, a, folderBody("位置甲")), 201); expect(await putFolder(h, alice, b, folderBody("位置乙")), 201);
  expect(await putLabel(h, alice, label, labelBody("保留标签")), 201);
  const key = crypto.randomUUID(), body = { messageIds: ids, folderId: a, starred: true, addLabelIds: [label] };
  expect(await organize(h, alice, body, key));
  assert.equal(expect(await h.request("/api/v1/messages", { cookie: alice.cookie })).items.length, 0);
  assert.equal(expect(await h.request(`/api/v1/messages?folderId=${a}`, { cookie: alice.cookie })).items.length, 2);
  assert.equal(expect(await messageFolder(h, alice, box, ids[0])).folder.id, a);
  expect(await organize(h, alice, { messageIds: ids, folderId: b })); expect(await organize(h, alice, body, key));
  assert.equal(expect(await messageFolder(h, alice, box, ids[0])).folder.id, b);
  expect(await h.request(`/api/v1/mailboxes/${box}/messages/${ids[0]}`, { method: "PATCH", cookie: alice.cookie, body: { archived: false } }));
  assert.equal(expect(await messageFolder(h, alice, box, ids[0])).folder, null);
  expect(await organize(h, alice, { messageIds: [ids[1]], archived: true }));
  assert.equal(expect(await messageFolder(h, alice, box, ids[1])).folder, null);
  expect(await organize(h, alice, { messageIds: ids, folderId: a, trashed: true }));
  expect(await deleteFolder(h, alice, a, 1));
  assert.equal(expect(await h.request("/api/v1/messages?folder=trash", { cookie: alice.cookie })).items.length, 2);
  expect(await organize(h, alice, { messageIds: ids, trashed: false }));
  assert.equal(expect(await h.request("/api/v1/messages", { cookie: alice.cookie })).items.length, 2);
  assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM message_labels WHERE label_id=?").bind(label).first("n"), 2);
  assert.equal(await h.db.prepare("SELECT text_body FROM messages WHERE id=?").bind(ids[0]).first("text_body"), "body");
  await h.restart(); assert.equal(expect(await messageFolder(h, alice, box, ids[0])).folder, null);
});
