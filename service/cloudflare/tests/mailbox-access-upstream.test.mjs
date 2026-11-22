import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { upstreamFixture } from "./upstream-fixture.mjs";
let f;
before(async () => { f = await upstreamFixture(); }, { timeout: 90000 });
after(async () => { await f?.close(); });

test("identity proof requires verified mailbox JWT and returns the exact live generation without writes", async () => {
  const box = await f.create();
  const before = await f.db.prepare("SELECT * FROM address WHERE id=?").bind(box.id).first();
  const result = await f.request("/api/mailbox_identity", { token: box.jwt });
  assert.equal(result.status, 200, result.text);
  assert.deepEqual(result.body, { contract: "easyemail-mailbox-identity-v1", addressId: String(box.id), address: box.address, expiresAt: null });
  assert.deepEqual(await f.db.prepare("SELECT * FROM address WHERE id=?").bind(box.id).first(), before);
  assert.equal((await f.request("/api/mailbox_identity", { admin: true })).status, 401);
  assert.equal((await f.request("/api/mailbox_identity", { token: "invalid" })).status, 401);
  assert.equal((await f.request("/api/mailbox_identity", { token: box.jwt, site: false })).status, 401);
});

test("a deleted or recycled address cannot be recovered using a signed old-generation token", async () => {
  const box = await f.create();
  await f.db.prepare("DELETE FROM address WHERE id=?").bind(box.id).run();
  const replacement = await f.create(box.address.split("@")[0]); assert.notEqual(replacement.id, box.id);
  assert.equal((await f.request("/api/mailbox_identity", { token: box.jwt })).status, 403);
  assert.equal((await f.request("/api/mailbox_identity", { token: replacement.jwt })).body.addressId, String(replacement.id));
});
