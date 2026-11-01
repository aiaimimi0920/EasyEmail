import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createHarness, newKey } from "./runtime-harness.mjs";
import { allocate } from "./provider-fixture.mjs";
import { remoteFixture } from "./remote-fixture.mjs";

let f, h, alice, bob, serial = 100;
before(async () => {
  f = await remoteFixture(); h = await createHarness(f.bindings);
  alice = await h.register("remote-runtime-alice"); bob = await h.register("remote-runtime-bob");
}, { timeout: 90000 });
beforeEach(async () => { await h.resetLimits(); f.modes.clear(); });
after(async () => { await h?.close(); await f?.close(); }, { timeout: 15000 });
const writes = () => f.calls.filter((call) => call.path === "/cf/api/mail_deletions" && call.method === "POST");
async function sample() {
  const box = (await allocate(h, alice.cookie)).body.mailbox, remoteId = ++serial;
  await f.seed(box.address, remoteId);
  const sync = await h.request(`/api/v1/mailboxes/${box.id}/sync`, { method: "POST", cookie: alice.cookie, body: {} });
  assert.equal(sync.status, 200, sync.text);
  const message = (await h.request(`/api/v1/mailboxes/${box.id}/messages`, { cookie: alice.cookie })).body.items[0];
  const path = `/api/v1/mailboxes/${box.id}/messages/${message.id}`;
  return { box, remoteId, message, path, endpoint: `${path}/remote-delete`,
    body: { confirmAddress: box.address, confirmMessageId: message.id } };
}
async function trash(s) { assert.equal((await h.request(s.path, { method: "DELETE", cookie: alice.cookie })).status, 200); }
const remove = (s, key = crypto.randomUUID(), extra = {}) => h.request(s.endpoint, { method: "POST", cookie: alice.cookie,
  body: s.body, headers: { "idempotency-key": key }, ...extra });

test("remote deletion is separately authorized, confirmed and keeps platform cache and replay guards", async () => {
  const s = await sample(), key = crypto.randomUUID(), count = writes().length;
  assert.equal((await remove(s)).body.error.code, "message_not_trashed"); await trash(s);
  const cleaner = await newKey(h, alice.cookie, { scopes: ["messages:delete", "messages:read"] });
  assert.equal((await remove(s, key, { token: cleaner.token })).status, 403);
  assert.equal((await remove(s, key, { cookie: bob.cookie })).status, 404);
  assert.equal((await remove(s, key, { origin: null })).status, 403);
  assert.equal((await remove(s, key, { body: { ...s.body, confirmAddress: "wrong@example.test" } })).status, 400);
  const first = await remove(s, key); assert.equal(first.status, 200, first.text);
  assert.equal(first.body.deletion.state, "deleted"); assert.equal(writes().length, count + 1);
  assert.equal(await f.db.prepare("SELECT id FROM raw_mails WHERE id=?").bind(s.remoteId).first(), null);
  assert.ok((await h.request(s.path, { cookie: alice.cookie })).body.message.textBody);
  assert.equal((await remove(s, key)).body.deletion.id, first.body.deletion.id);
  assert.equal((await remove(s)).body.deletion.id, first.body.deletion.id); assert.equal(writes().length, count + 1);
  assert.equal((await remove(s, key, { body: { ...s.body, confirmMessageId: crypto.randomUUID() } })).status, 400);
  await h.request(`${s.path}/purge`, { method: "POST", cookie: alice.cookie, body: { confirmMessageId: s.message.id } });
  await h.restart();
  assert.equal((await h.request(s.endpoint, { cookie: alice.cookie })).body.deletion.id, first.body.deletion.id);
  assert.equal((await remove(s, key)).body.deletion.state, "deleted"); assert.equal(writes().length, count + 1);
});

test("lost response stays unknown across refresh/restart and explicit check only reads durable upstream outcome", async () => {
  const s = await sample(); await trash(s); const key = crypto.randomUUID(), count = writes().length;
  f.modes.set("/cf/api/mail_deletions", "lose-response");
  const lost = await remove(s, key); assert.equal(lost.status, 202, lost.text); assert.equal(lost.body.deletion.state, "unknown");
  await h.restart();
  assert.equal((await remove(s, key)).body.deletion.state, "unknown"); assert.equal(writes().length, count + 1);
  assert.equal((await h.request(s.endpoint, { cookie: alice.cookie })).body.deletion.state, "unknown");
  const checked = await h.request(`${s.endpoint}/check`, { method: "POST", cookie: alice.cookie, body: {} });
  assert.equal(checked.body.deletion.state, "deleted", checked.text); assert.equal(writes().length, count + 1);
  assert.ok(f.calls.some((call) => call.path.endsWith(lost.body.deletion.id) && call.method === "GET"));
});

test("ID and identical-content reuse gets a separate cached generation; stale delete cannot remove it", async () => {
  const s = await sample(); await trash(s);
  const original = await f.db.prepare("SELECT * FROM raw_mails WHERE id=?").bind(s.remoteId).first();
  await f.db.prepare("DELETE FROM raw_mails WHERE id=?").bind(s.remoteId).run();
  await f.db.prepare("INSERT INTO raw_mails(id,address,raw,message_id,created_at) VALUES(?,?,?,?,?)")
    .bind(s.remoteId, original.address, original.raw, original.message_id, original.created_at).run();
  const result = await remove(s); assert.equal(result.body.deletion.state, "changed", result.text);
  assert.ok(await f.db.prepare("SELECT id FROM raw_mails WHERE id=?").bind(s.remoteId).first());
  assert.equal((await h.request(`/api/v1/mailboxes/${s.box.id}/sync`, { method: "POST", cookie: alice.cookie, body: {} })).body.sync.inserted, 1);
  const rows = (await h.db.prepare("SELECT id,source_version FROM messages WHERE mailbox_id=?").bind(s.box.id).all()).results;
  assert.equal(rows.length, 2); assert.notEqual(rows[0].source_version, rows[1].source_version);
  assert.equal((await h.request(`/api/v1/mailboxes/${s.box.id}/sync`, { method: "POST", cookie: alice.cookie, body: {} })).body.sync.inserted, 0);
});

test("non-versioned cache and disabled mailboxes refuse writes; no fallback to unconditional DELETE", async () => {
  const s = await sample(); await trash(s); const count = writes().length;
  await h.db.prepare("UPDATE messages SET source_version=NULL WHERE id=?").bind(s.message.id).run();
  assert.equal((await remove(s)).body.error.code, "remote_delete_unavailable");
  const next = await sample(); await trash(next);
  await h.request(`/api/v1/mailboxes/${next.box.id}/lifecycle`, { method: "POST", cookie: alice.cookie, body: { action: "disable" } });
  assert.equal((await remove(next)).body.error.code, "mailbox_disabled"); assert.equal(writes().length, count);
  assert.equal(f.calls.some((call) => call.method === "DELETE"), false);
});

test("reservation failure sends nothing; in-flight disable cannot cancel an already dispatched deletion", async () => {
  const s = await sample(); await trash(s); const count = writes().length;
  await h.db.prepare("CREATE TRIGGER fail_remote_guard BEFORE INSERT ON remote_deletions BEGIN SELECT RAISE(ABORT,'synthetic'); END").run();
  try { assert.equal((await remove(s)).status, 503); } finally { await h.db.prepare("DROP TRIGGER fail_remote_guard").run(); }
  assert.equal(writes().length, count);
  const gate = f.hold("/cf/api/mail_deletions"), pending = remove(s);
  try {
    await gate.entered;
    await h.request(`/api/v1/mailboxes/${s.box.id}/lifecycle`, { method: "POST", cookie: alice.cookie, body: { action: "disable" } });
  } finally { gate.release(); }
  assert.equal((await pending).body.deletion.state, "deleted"); assert.equal(writes().length, count + 1);
});

test("upstream 404 remains unknown; a later original POST can still finish, without re-dispatch or terminal regression", async () => {
  const s = await sample(); await trash(s); const count = writes().length;
  const gate = f.hold("/cf/api/mail_deletions"), pending = remove(s);
  try {
    await gate.entered;
    assert.equal((await h.request(s.endpoint, { cookie: bob.cookie })).status, 404);
    const result = await h.request(`${s.endpoint}/check`, { method: "POST", cookie: alice.cookie, body: {} });
    assert.equal(result.status, 202, result.text); assert.equal(result.body.deletion.state, "unknown");
    assert.equal((await remove(s)).body.deletion.id, result.body.deletion.id); assert.equal(writes().length, count + 1);
  } finally { gate.release(); }
  const finished = await pending; assert.equal(finished.body.deletion.state, "deleted", finished.text);
  assert.equal((await h.request(s.endpoint, { cookie: alice.cookie })).body.deletion.state, "deleted");
  assert.equal(writes().length, count + 1);
});

test("result storage failure is explicit, keeps reservation, and only a read-only check can reconcile", async () => {
  const s = await sample(); await trash(s); const key = crypto.randomUUID(), count = writes().length;
  await h.db.prepare("CREATE TRIGGER fail_remote_result BEFORE UPDATE ON remote_deletions BEGIN SELECT RAISE(ABORT,'synthetic'); END").run();
  try { assert.equal((await remove(s, key)).body.error.code, "remote_delete_storage_failed"); }
  finally { await h.db.prepare("DROP TRIGGER fail_remote_result").run(); }
  assert.equal((await remove(s, key)).body.deletion.state, "pending"); assert.equal(writes().length, count + 1);
  const checker = await newKey(h, alice.cookie, { scopes: ["messages:remote-delete"] });
  assert.equal((await h.request(`${s.endpoint}/check`, { method: "POST", token: checker.token, origin: null, body: {} })).body.deletion.state, "deleted");
  assert.equal(writes().length, count + 1);
});

test("pending operation status never sends its credential to a changed provider endpoint", async () => {
  const s = await sample(); await trash(s); f.modes.set("/cf/api/mail_deletions", 503);
  assert.equal((await remove(s)).body.deletion.state, "unknown"); const count = f.calls.length;
  const configs = JSON.parse(f.bindings.PROVIDER_CONFIG); configs[0].baseUrl += "-changed";
  try {
    await h.restart({ PROVIDER_CONFIG: JSON.stringify(configs) });
    assert.equal((await h.request(`${s.endpoint}/check`, { method: "POST", cookie: alice.cookie, body: {} })).body.error.code, "provider_config_changed");
    assert.equal(f.calls.length, count); assert.equal((await h.request(s.endpoint, { cookie: alice.cookie })).body.deletion.state, "unknown");
  } finally { await h.restart(f.bindings); }
});
