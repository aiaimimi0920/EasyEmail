import assert from "node:assert/strict";
import { test } from "node:test";
import { normalFoldersFixture } from "./normal-folders-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";

test("explicit folder discovery publishes a durable private catalog without touching INBOX or platform folders", async () => {
  const t = await normalFoldersFixture();
  try {
    assert.equal((await t.cached()).body.catalog.observedAt, null); assert.equal(t.opens.length, 0);
    const result = await t.discover(); assert.equal(result.status, 200, result.text);
    assert.equal(result.body.catalog.items.length, 5); assert.equal(result.body.catalog.current, true);
    const first = result.body.catalog; assert.equal(first.complete, true); assert.ok(first.snapshotId);
    await t.h.restart(); assert.deepEqual((await t.cached()).body.catalog, first); assert.equal(t.opens.length, 1);
    assert.equal((await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_state").first()).n, 0);
    assert.equal((await t.h.db.prepare("SELECT COUNT(*) n FROM folders").first()).n, 0);
    const second = (await t.discover()).body.catalog;
    assert.notEqual(second.snapshotId, first.snapshotId); assert.deepEqual(second.items.map(row => row.id), first.items.map(row => row.id));
    assert.equal(t.calls.some(line => /EXAMINE|SELECT|FETCH|STORE|MOVE|EXPUNGE/.test(line)), false);
    assert.deepEqual((await t.h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await t.close(); }
});
test("catalog read, explicit network discovery, Origin, ownership and revision permissions are separate", async () => {
  const t = await normalFoldersFixture();
  try {
    const read = await newKey(t.h, t.alice.cookie, { scopes: ["mail-accounts:read", "messages:read"] });
    assert.equal((await t.cached({ cookie: undefined, token: read.token })).status, 200);
    assert.equal((await t.discover(1, { cookie: undefined, token: read.token })).status, 403);
    assert.equal((await t.discover(1, { origin: "https://evil.invalid" })).status, 403);
    assert.equal((await t.discover(2)).status, 409);
    const bob = await t.h.register("folders-other-owner"); assert.equal((await t.cached({ cookie: bob.cookie })).status, 404);
    assert.equal((await t.discover(1, { body: { expectedRevision: 1, path: "INBOX" } })).status, 400);
    assert.equal(t.opens.length, 0);
    const sync = await newKey(t.h, t.alice.cookie, { scopes: ["mail-accounts:read", "messages:read", "mail-accounts:sync"] });
    assert.equal((await t.discover(1, { cookie: undefined, token: sync.token, origin: null })).status, 200);
  } finally { await t.close(); }
});
test("failed or incomplete discovery preserves the last complete snapshot; source changes hide stale names", async () => {
  const t = await normalFoldersFixture();
  try {
    const first = (await t.discover()).body.catalog;
    t.scenario({ rows: ['* LIST () "/" INBOX\r\n', '* LIST () "/" "&broken-"\r\n'] });
    assert.equal((await t.discover()).status, 502); assert.deepEqual((await t.cached()).body.catalog, first);
    assert.equal((await t.save({ username: "Changed", password: "new-password" }, 1)).status, 200);
    const hidden = (await t.cached()).body.catalog; assert.equal(hidden.current, false); assert.deepEqual(hidden.items, []);
    assert.equal(hidden.observedAt, null); assert.equal(hidden.snapshotId, null);
  } finally { await t.close(); }
});
test("lease and credential fences prevent late discovery from publishing over changed ownership or configuration", async () => {
  const t = await normalFoldersFixture(); let gate;
  try {
    const first = (await t.discover()).body.catalog;
    const key = await newKey(t.h, t.alice.cookie, { scopes: ["mail-accounts:read", "messages:read", "mail-accounts:sync"] });
    gate = t.holdCommand(/ LIST /); const pending = t.discover(1, { cookie: undefined, token: key.token }); await gate.entered;
    assert.equal((await t.discover()).status, 409);
    assert.equal((await t.h.request(`/api/v1/api-keys/${key.id}`, { method: "DELETE", cookie: t.alice.cookie })).status, 200);
    gate.release(); gate = null; assert.equal((await pending).status, 409);
    assert.deepEqual((await t.cached()).body.catalog, first);
  } finally { gate?.release(); await t.close(); }
});
