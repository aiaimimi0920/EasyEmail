import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { newKey } from "./runtime-harness.mjs";
import { foldersFixture, folderBody, folderPath, putFolder, deleteFolder, messageFolder, organize, expect } from "./folders-fixture.mjs";

let f, h, alice, bob, box, ids;
before(async () => { f = await foldersFixture(); ({ h, alice, bob, box, ids } = f); });
beforeEach(async () => h.resetLimits()); after(async () => f?.close());

test("folder definitions, placement and receipts enforce separate scopes, owner and session Origin", async () => {
  const folder = crypto.randomUUID(); expect(await putFolder(h, alice, folder), 201);
  const old = await newKey(h, alice.cookie, { scopes: ["messages:read", "messages:write"] });
  const read = await newKey(h, alice.cookie, { scopes: ["folders:read", "messages:read", "messages:write"] });
  const write = await newKey(h, alice.cookie, { scopes: ["folders:write"] });
  expect(await h.request(folderPath(), { token: old.token }), 403);
  expect(await messageFolder(h, alice, box, ids[0], { token: old.token }), 403);
  expect(await putFolder(h, alice, crypto.randomUUID(), folderBody("writer"), { token: write.token, origin: null }), 201);
  expect(await putFolder(h, alice, crypto.randomUUID(), folderBody("denied"), { token: read.token }), 403);
  expect(await putFolder(h, alice, crypto.randomUUID(), folderBody("no-origin"), { origin: null }), 403);
  expect(await deleteFolder(h, alice, folder, 1, { origin: "https://attacker.test" }), 403);
  expect(await messageFolder(h, bob, box, ids[0]), 404);
  expect(await putFolder(h, bob, crypto.randomUUID(), folderBody("foreign parent", folder)), 409);
  expect(await organize(h, alice, { messageIds: ids, folderId: folder }, crypto.randomUUID(), { token: old.token }), 403);
  expect(await organize(h, alice, { messageIds: ids, folderId: null }, crypto.randomUUID(), { token: old.token }), 403);
  const move = expect(await organize(h, alice, { messageIds: ids, folderId: folder }, crypto.randomUUID(), { token: read.token, origin: null }));
  expect(await h.request(`/api/v1/organization/${move.operation.key}`, { token: old.token }), 403);
  expect(await h.request(`/api/v1/messages?folderId=${folder}`, { token: old.token }), 403);
  expect(await h.request(`/api/v1/messages?folderId=${folder}`, { cookie: bob.cookie }), 404);
  const all = expect(await h.request("/api/v1/messages?folder=all", { token: old.token }));
  assert.equal(all.items.length, 2); assert.equal(Object.hasOwn(all.items[0], "folderId"), false);
  expect(await h.request(`/api/v1/mailboxes/${box}/messages/${ids[0]}`, { token: old.token, method: "PATCH", origin: null, body: { archived: false } }));
  assert.equal(expect(await messageFolder(h, alice, box, ids[0])).folder, null);
});

test("strict folder schemas, pagination and query cursor binding reject ambiguous input", async () => {
  for (const body of [folderBody(" "), folderBody("x".repeat(41)), folderBody("a\u200bb"), folderBody("a\nb"), folderBody("x", "invalid"),
    folderBody("x", null, -1), folderBody("x", null, 0, "#123456"), { ...folderBody(), userId: bob.id }]) expect(await putFolder(h, alice, crypto.randomUUID(), body), 400);
  for (const body of [{ messageIds: ids, folderId: "" }, { messageIds: ids, folderId: false },
    { messageIds: ids, folderId: crypto.randomUUID(), archived: false }]) expect(await organize(h, alice, body), 400);
  for (const query of ["limit=0", "limit=1&limit=2", "name=x", "cursor=broken"]) expect(await h.request(`${folderPath()}?${query}`, { cookie: alice.cookie }), 400);
  for (const query of ["folderId=", `folderId=${crypto.randomUUID()}&folderId=${crypto.randomUUID()}`]) expect(await h.request(`/api/v1/messages?${query}`, { cookie: alice.cookie }), 400);
  const folder = crypto.randomUUID(); expect(await putFolder(h, alice, folder, folderBody("分页")), 201);
  expect(await organize(h, alice, { messageIds: ids, folderId: folder }));
  const page = expect(await h.request(`/api/v1/messages?folderId=${folder}&limit=1`, { cookie: alice.cookie }));
  assert.ok(page.nextCursor); expect(await h.request(`/api/v1/messages?cursor=${page.nextCursor}`, { cookie: alice.cookie }), 400);
  expect(await h.request(`/api/v1/messages?folderId=${folder}&cursor=${page.nextCursor}`, { cookie: bob.cookie }), 400);
  expect(await h.request(folderPath(), { method: "POST", cookie: alice.cookie, body: folderBody() }), 405);
});

test("concurrent folder quota inserts cannot exceed 100 active records", async () => {
  const user = await h.register("folder-quota-user"), now = Math.floor(Date.now() / 1000);
  await h.db.batch(Array.from({ length: 99 }, (_, i) => h.db.prepare(`INSERT INTO folders(user_id,id,name,name_key,color,revision,created_at,updated_at)
    VALUES(?,?,?,?,'blue',1,?,?)`).bind(user.id, crypto.randomUUID(), `folder${i}`, `folder${i}`, now, now)));
  const result = await Promise.all([putFolder(h, user, crypto.randomUUID(), folderBody("quota-a")), putFolder(h, user, crypto.randomUUID(), folderBody("quota-b"))]);
  assert.deepEqual(result.map(x => x.status).sort(), [201, 409]);
  assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM folders WHERE user_id=? AND deleted_at IS NULL").bind(user.id).first("n"), 100);
});
