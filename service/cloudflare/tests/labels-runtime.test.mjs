import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { labelsFixture, labelBody, labelPath, putLabel, organize, messageLabels, expect } from "./labels-fixture.mjs";

let f, h, alice, bob, box, ids, foreign;
before(async () => { f = await labelsFixture(); ({ h, alice, bob, box, ids, foreign } = f); });
beforeEach(async () => h.resetLimits());
after(async () => f?.close());

test("private labels normalize names, compare revisions, replay only the adjacent save and cannot resurrect", async () => {
  const id = crypto.randomUUID();
  assert.equal(expect(await putLabel(h, alice, id, labelBody("  Cafe\u0301  ")), 201).label.name, "Café");
  assert.equal(expect(await putLabel(h, alice, id, labelBody("Café"))).label.revision, 1);
  expect(await putLabel(h, alice, crypto.randomUUID(), labelBody("CAFÉ")), 409);
  const updated = expect(await putLabel(h, alice, id, labelBody("待办", 1, "green"))).label;
  assert.equal(updated.revision, 2);
  expect(await h.request(labelPath(id), { method: "DELETE", cookie: alice.cookie, body: { expectedRevision: 1 } }), 409);
  expect(await putLabel(h, alice, id, labelBody("过期编辑", 1)), 409);
  const remove = () => h.request(labelPath(id), { method: "DELETE", cookie: alice.cookie, body: { expectedRevision: 2 } });
  expect(await remove()); expect(await remove());
  expect(await putLabel(h, alice, id), 409);
  expect(await putLabel(h, alice, crypto.randomUUID(), labelBody("待办")), 201);
  assert.equal(expect(await h.request(labelPath(), { cookie: bob.cookie })).items.length, 0);
});

test("batch organization is all-or-nothing, explicit and receipts do not replay old writes", async () => {
  const id = crypto.randomUUID(), key = crypto.randomUUID();
  expect(await putLabel(h, alice, id), 201);
  const body = { messageIds: ids, isRead: true, starred: true, addLabelIds: [id] };
  const first = expect(await organize(h, alice, body, key));
  assert.equal(first.operation.messageCount, 2); assert.equal(first.replayed, false);
  assert.deepEqual(expect(await messageLabels(h, alice, box, ids[0])).items.map(x => x.id), [id]);
  expect(await organize(h, alice, { messageIds: ids, starred: false, removeLabelIds: [id], archived: true }));
  const replay = expect(await organize(h, alice, { ...body, messageIds: [...ids].reverse() }, key));
  assert.equal(replay.replayed, true); assert.equal(replay.operation.id, first.operation.id);
  assert.equal(expect(await messageLabels(h, alice, box, ids[0])).items.length, 0);
  assert.equal(await h.db.prepare("SELECT starred FROM messages WHERE id=?").bind(ids[0]).first("starred"), 0);
  expect(await organize(h, alice, { ...body, archived: true }, key), 409);
  expect(await organize(h, alice, { messageIds: [ids[0], foreign], isRead: false }), 409);
  assert.equal(await h.db.prepare("SELECT is_read FROM messages WHERE id=?").bind(ids[0]).first("is_read"), 1);
  expect(await organize(h, alice, { messageIds: ids, trashed: true }));
  assert.equal(expect(await h.request("/api/v1/messages?folder=trash", { cookie: alice.cookie })).items.length, 2);
  expect(await organize(h, alice, { messageIds: ids, trashed: false, archived: false }));
  await h.restart();
  assert.equal(expect(await h.request(`/api/v1/organization/${key}`, { cookie: alice.cookie })).operation.id, first.operation.id);
  assert.equal(expect(await h.request("/api/v1/messages", { cookie: alice.cookie })).items.length, 2);
});

test("label deletion removes associations atomically and filters bind the selected label and owner", async () => {
  const id = crypto.randomUUID(); expect(await putLabel(h, alice, id, labelBody("筛选")), 201);
  expect(await organize(h, alice, { messageIds: ids, addLabelIds: [id] }));
  const page = expect(await h.request(`/api/v1/messages?labelId=${id}&limit=1`, { cookie: alice.cookie }));
  assert.equal(page.items.length, 1); assert.ok(page.nextCursor);
  expect(await h.request(`/api/v1/messages?cursor=${page.nextCursor}`, { cookie: alice.cookie }), 400);
  expect(await h.request(`/api/v1/messages?labelId=${id}`, { cookie: bob.cookie }), 404);
  expect(await h.request(labelPath(id), { method: "DELETE", cookie: alice.cookie, body: { expectedRevision: 1 } }));
  assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM message_labels WHERE label_id=?").bind(id).first("n"), 0);
  expect(await h.request(`/api/v1/messages?labelId=${id}`, { cookie: alice.cookie }), 404);
  expect(await organize(h, alice, { messageIds: ids, addLabelIds: [id] }), 409);
});
