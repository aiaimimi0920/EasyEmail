import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { newKey } from "./runtime-harness.mjs";
import { labelsFixture, seedMessage, labelBody, labelPath, putLabel, organize, messageLabels, expect } from "./labels-fixture.mjs";

let f, h, alice, bob, box, ids;
before(async () => { f = await labelsFixture(); ({ h, alice, bob, box, ids } = f); });
beforeEach(async () => h.resetLimits());
after(async () => f?.close());

test("label and message operations enforce independent scopes, owner, Origin and unchanged legacy summaries", async () => {
  const label = crypto.randomUUID(); expect(await putLabel(h, alice, label), 201);
  const old = await newKey(h, alice.cookie, { scopes: ["messages:read", "messages:write"] });
  const labelWriter = await newKey(h, alice.cookie, { scopes: ["labels:write"] });
  const labelReader = await newKey(h, alice.cookie, { scopes: ["labels:read"] });
  expect(await h.request(labelPath(), { token: old.token }), 403);
  expect(await messageLabels(h, alice, box, ids[0], { token: old.token }), 403);
  expect(await putLabel(h, alice, crypto.randomUUID(), labelBody("no-origin"), { origin: null }), 403);
  expect(await putLabel(h, alice, crypto.randomUUID(), labelBody("key-label"), { token: labelWriter.token, origin: null }), 201);
  expect(await putLabel(h, alice, crypto.randomUUID(), labelBody("deny"), { token: labelReader.token }), 403);
  expect(await organize(h, alice, { messageIds: ids, isRead: true }, crypto.randomUUID(), { token: old.token, origin: null }));
  expect(await organize(h, alice, { messageIds: ids, addLabelIds: [label] }, crypto.randomUUID(), { token: old.token }), 403);
  expect(await organize(h, alice, { messageIds: ids, trashed: true }, crypto.randomUUID(), { token: old.token }), 403);
  expect(await organize(h, alice, { messageIds: ids, isRead: false }, crypto.randomUUID(), { origin: "https://attacker.test" }), 403);
  expect(await organize(h, bob, { messageIds: ids, starred: true }), 409);
  expect(await messageLabels(h, bob, box, ids[0]), 404);
  expect(await h.request(`/api/v1/messages?labelId=${label}`, { token: old.token }), 403);
  const receipt = expect(await organize(h, alice, { messageIds: ids, addLabelIds: [label] })).operation;
  expect(await h.request(`/api/v1/organization/${receipt.key}`, { token: old.token }), 403);
  expect(await h.request(`/api/v1/organization/${receipt.key}`, { cookie: bob.cookie }), 404);
  const summary = expect(await h.request("/api/v1/messages", { token: old.token })).items[0];
  assert.equal(Object.hasOwn(summary, "labels"), false);
  const scopes = await h.db.prepare("SELECT scopes FROM api_keys WHERE id=?").bind(old.id).first("scopes");
  assert.deepEqual(JSON.parse(scopes), ["messages:read", "messages:write"]);
});

test("strict bounded schemas reject malformed names, fields, identifiers, booleans, keys and filters", async () => {
  for (const body of [labelBody(" "), labelBody("x".repeat(41)), labelBody("a\u200bb"), labelBody("a\nb"),
    labelBody("x", -1), labelBody("x", 0, "url(javascript:alert(1))"), { ...labelBody(), owner: bob.id }]) {
    expect(await putLabel(h, alice, crypto.randomUUID(), body), 400);
  }
  const id = crypto.randomUUID();
  for (const body of [{}, { messageIds: [] }, { messageIds: ids }, { messageIds: [ids[0], ids[0]], isRead: true },
    { messageIds: ids, isRead: null }, { messageIds: ids, isRead: "true" }, { messageIds: ids, addLabelIds: [id], removeLabelIds: [id] },
    { messageIds: ids, addLabelIds: Array(21).fill(id) }, { messageIds: Array.from({ length: 51 }, () => crypto.randomUUID()), isRead: true },
    { messageIds: ids, purge: true }, { messageIds: ["x".repeat(36)], starred: false }]) expect(await organize(h, alice, body), 400);
  expect(await organize(h, alice, { messageIds: ids, isRead: true }, "invalid"), 400);
  expect(await organize(h, alice, { messageIds: ids, isRead: true }, crypto.randomUUID(), { headers: {} }), 400);
  expect(await organize(h, alice, { messageIds: ids, isRead: true }, crypto.randomUUID(), { body: "x".repeat(8193) }), 413);
  for (const query of ["limit=0", "limit=1&limit=2", "q=x", "cursor=broken"]) expect(await h.request(`${labelPath()}?${query}`, { cookie: alice.cookie }), 400);
  for (const query of ["labelId=", `labelId=${id}&labelId=${id}`]) expect(await h.request(`/api/v1/messages?${query}`, { cookie: alice.cookie }), 400);
  expect(await h.request(labelPath(), { method: "POST", cookie: alice.cookie, body: labelBody() }), 405);
});

test("maximum batch works under D1 parameter limits and label quota remains atomic under concurrency", async () => {
  const user = await h.register("label-quota-user");
  const now = Math.floor(Date.now() / 1000);
  const initial = Array.from({ length: 99 }, (_, i) => h.db.prepare(`INSERT INTO labels(user_id,id,name,name_key,color,revision,created_at,updated_at)
    VALUES(?,?,?,?,'blue',1,?,?)`).bind(user.id, crypto.randomUUID(), `标签${i}`, `标签${i}`, now, now));
  await h.db.batch(initial);
  const outcomes = await Promise.all([putLabel(h, user, crypto.randomUUID(), labelBody("quota-a")), putLabel(h, user, crypto.randomUUID(), labelBody("quota-b"))]);
  assert.deepEqual(outcomes.map(x => x.status).sort(), [201, 409]);
  assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM labels WHERE user_id=? AND deleted_at IS NULL").bind(user.id).first("n"), 100);
  const messages = [...ids]; for (let i = 3; i <= 50; i++) messages.push(await seedMessage(h, alice.id, box, i));
  const labels = Array.from({ length: 20 }, () => crypto.randomUUID());
  await h.db.batch(labels.map((id, i) => h.db.prepare(`INSERT INTO labels(user_id,id,name,name_key,color,revision,created_at,updated_at)
    VALUES(?,?,?,?,'blue',1,?,?)`).bind(alice.id, id, `批量${i}`, `批量${i}`, now, now)));
  expect(await organize(h, alice, { messageIds: messages, isRead: true, starred: true, archived: true, addLabelIds: labels }));
  assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM message_labels WHERE user_id=?").bind(alice.id).first("n"), 1002);
});
