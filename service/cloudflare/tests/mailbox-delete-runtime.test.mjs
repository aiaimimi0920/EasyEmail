import assert from "node:assert/strict";
import { before, after, beforeEach, test } from "node:test";
import { mailboxDeleteFixture } from "./mailbox-delete-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";
let t;
before(async () => { t = await mailboxDeleteFixture(); }, { timeout: 90000 });
beforeEach(async () => { await t.h.resetLimits(); t.f.modes.clear(); });
after(async () => { await t?.close(); }, { timeout: 15000 });

test("conditional mailbox deletion is separately authorized and keeps cache/quota/send history while clearing platform credentials", async () => {
  const s = await t.sample(), bob = await t.h.register("mailbox-delete-other-user"), count = t.writes().length;
  await t.f.seed(s.box.address, s.remoteId);
  await t.h.request(`${s.path}/sync`, { method: "POST", cookie: t.alice.cookie, body: {} });
  const before = await t.h.db.prepare("SELECT * FROM messages WHERE mailbox_id=?").bind(s.box.id).first();
  const sent = await t.h.request(`${s.path}/outgoing`, { method: "POST", cookie: t.alice.cookie,
    body: { to: "recipient@example.test", subject: "Synthetic pre-delete send", text: "Local fixture only" }, headers: { "idempotency-key": crypto.randomUUID() } });
  assert.equal(sent.body.outgoing.state, "accepted", sent.text);
  const outgoing = (await t.h.db.prepare("SELECT * FROM outgoing_messages WHERE mailbox_id=?").bind(s.box.id).all()).results;
  const creation = await t.h.db.prepare("SELECT * FROM mailbox_creations WHERE mailbox_id=?").bind(s.box.id).first();
  const release = await newKey(t.h, t.alice.cookie, { scopes: ["mailboxes:delete"] });
  assert.equal((await t.remove(s, undefined, { token: release.token })).status, 403);
  assert.equal((await t.remove(s, undefined, { cookie: bob.cookie })).status, 404);
  assert.equal((await t.remove(s, undefined, { origin: null })).status, 403);
  assert.equal((await t.remove(s, undefined, { body: { ...s.body, confirmAddress: "wrong@example.test" } })).status, 400);
  const key = crypto.randomUUID(), result = await t.remove(s, key);
  assert.equal(result.status, 200, result.text); assert.equal(result.body.deletion.state, "deleted");
  assert.equal(result.body.deletion.externalResourcesDeleted, false); assert.equal(t.writes().length, count + 1);
  const box = await t.h.db.prepare("SELECT * FROM mailboxes WHERE id=?").bind(s.box.id).first();
  assert.equal(box.credential_cipher, null); assert.ok(box.released_at); assert.ok(box.disabled_at);
  assert.equal(await t.f.db.prepare("SELECT id FROM address WHERE id=?").bind(s.remoteId).first(), null);
  assert.deepEqual(await t.h.db.prepare("SELECT * FROM messages WHERE mailbox_id=?").bind(s.box.id).first(), before);
  assert.deepEqual((await t.h.db.prepare("SELECT * FROM outgoing_messages WHERE mailbox_id=?").bind(s.box.id).all()).results, outgoing);
  assert.deepEqual(await t.h.db.prepare("SELECT * FROM mailbox_creations WHERE mailbox_id=?").bind(s.box.id).first(), creation);
  await t.h.restart();
  assert.deepEqual((await t.remove(s, key)).body, result.body); assert.deepEqual((await t.remove(s)).body, result.body);
  assert.equal(t.writes().length, count + 1);
});

test("independent API scope, exact confirmation and idempotency namespace never authorize another mailbox", async () => {
  const s = await t.sample(), other = await t.sample(), key = crypto.randomUUID(), count = t.writes().length;
  for (const body of [{}, { ...s.body, extra: true }, { ...s.body, confirmMailboxId: other.box.id }]) {
    assert.equal((await t.remove(s, key, { body })).status, 400);
  }
  assert.equal((await t.remove(s, key, { headers: {} })).status, 400);
  const remote = await newKey(t.h, t.alice.cookie, { scopes: ["mailboxes:remote-delete"] });
  const result = await t.remove(s, key, { token: remote.token, origin: null });
  assert.equal(result.body.deletion.state, "deleted", result.text);
  assert.equal((await t.h.request(s.endpoint, { token: remote.token })).status, 403);
  assert.equal((await t.remove(other, key)).body.error.code, "idempotency_conflict");
  assert.equal((await t.check(s, { token: remote.token, origin: null })).body.deletion.id, result.body.deletion.id);
  assert.equal(t.writes().length, count + 1);
  const call = t.writes().at(-1); assert.ok(call.headers.authorization.startsWith("Bearer ey")); assert.equal(call.headers["x-admin-auth"], undefined);
});

test("unavailable or malformed capabilities never reserve or fall back to the legacy address DELETE", async () => {
  const s = await t.sample(), count = t.writes().length;
  const capability = { address: s.box.address, addressId: String(s.remoteId), conditionalDelete: true, enabled: true,
    cleanup: "d1-mailbox-data-v1", externalResourcesDeleted: false };
  for (const mode of [404, 503, { capability: { ...capability, enabled: false } },
    { capability: { ...capability, addressId: String(s.remoteId + 1) } }, { capability: { ...capability, externalResourcesDeleted: true } }]) {
    t.f.modes.set("/cf/api/address_deletion_capability", mode);
    assert.ok((await t.remove(s)).status >= 400);
    assert.equal(await t.h.db.prepare("SELECT id FROM remote_mailbox_deletions WHERE mailbox_id=?").bind(s.box.id).first(), null);
    const box = await t.h.db.prepare("SELECT disabled_at,credential_cipher FROM mailboxes WHERE id=?").bind(s.box.id).first();
    assert.equal(box.disabled_at, null); assert.ok(box.credential_cipher);
  }
  t.f.modes.clear(); assert.equal(t.writes().length, count); assert.equal(t.f.calls.some((call) => call.method === "DELETE"), false);
});

test("invalid terminal identity stays unknown, cannot re-enable, and an unobserved receipt is never interpreted as absent", async () => {
  const s = await t.sample(), count = t.writes().length;
  t.f.modes.set("/cf/api/address_deletions", { operation: { state: "deleted", requestId: crypto.randomUUID(), address: s.box.address, addressId: String(s.remoteId) },
    cleanup: "d1-mailbox-data-v1", externalResourcesDeleted: false });
  const result = await t.remove(s); assert.equal(result.status, 202, result.text);
  assert.equal(result.body.deletion.state, "unknown"); assert.equal((await t.check(s)).body.deletion.state, "unknown");
  assert.equal((await t.h.request(`${s.path}/lifecycle`, { method: "POST", cookie: t.alice.cookie, body: { action: "enable" } })).body.error.code,
    "remote_mailbox_delete_in_progress");
  assert.equal((await t.remove(s)).body.deletion.id, result.body.deletion.id); assert.equal(t.writes().length, count + 1);
  assert.ok((await t.h.db.prepare("SELECT credential_cipher FROM mailboxes WHERE id=?").bind(s.box.id).first()).credential_cipher);
});

test("reservation and disable are atomic; SQL failures dispatch no delete and expose no private error", async () => {
  for (const step of ["INSERT ON remote_mailbox_deletions", "UPDATE OF disabled_at ON mailboxes"]) {
    const s = await t.sample(), count = t.writes().length;
    await t.h.db.prepare(`CREATE TRIGGER fixture_fail_mailbox_reserve BEFORE ${step} BEGIN SELECT RAISE(ABORT,'private synthetic SQL'); END`).run();
    try {
      const result = await t.remove(s); assert.equal(result.status, 503); assert.equal(result.body.error.code, "remote_mailbox_delete_storage_failed");
      assert.equal(result.text.includes("private synthetic SQL"), false); assert.equal(t.writes().length, count);
      assert.equal(await t.h.db.prepare("SELECT id FROM remote_mailbox_deletions WHERE mailbox_id=?").bind(s.box.id).first(), null);
      assert.equal((await t.h.db.prepare("SELECT disabled_at FROM mailboxes WHERE id=?").bind(s.box.id).first()).disabled_at, null);
    } finally { await t.h.db.prepare("DROP TRIGGER fixture_fail_mailbox_reserve").run(); }
  }
});

test("result and credential release roll back together; only a read-only check repairs a persisted pending result", async () => {
  const s = await t.sample(), count = t.writes().length, key = crypto.randomUUID();
  await t.h.db.prepare(`CREATE TRIGGER fixture_fail_credential_release BEFORE UPDATE OF credential_cipher ON mailboxes
    WHEN OLD.credential_cipher IS NOT NULL AND NEW.credential_cipher IS NULL BEGIN SELECT RAISE(ABORT,'private release SQL'); END`).run();
  try { assert.equal((await t.remove(s, key)).body.error.code, "remote_mailbox_delete_storage_failed"); }
  finally { await t.h.db.prepare("DROP TRIGGER fixture_fail_credential_release").run(); }
  const row = await t.h.db.prepare("SELECT * FROM remote_mailbox_deletions WHERE mailbox_id=?").bind(s.box.id).first(); assert.equal(row.state, "pending");
  assert.ok((await t.h.db.prepare("SELECT credential_cipher FROM mailboxes WHERE id=?").bind(s.box.id).first()).credential_cipher);
  assert.equal((await t.remove(s, key)).body.deletion.id, row.id);
  assert.equal((await t.check(s)).body.deletion.state, "deleted"); assert.equal(t.writes().length, count + 1);
});

test("an unknown operation never sends its mailbox credential to a revised provider endpoint", async () => {
  const s = await t.sample(); t.f.modes.set("/cf/api/address_deletions", 503);
  assert.equal((await t.remove(s)).body.deletion.state, "unknown"); const count = t.f.calls.length;
  const config = JSON.parse(t.bindings.PROVIDER_CONFIG); config[0].baseUrl += "-changed";
  try {
    await t.h.restart({ PROVIDER_CONFIG: JSON.stringify(config) });
    assert.equal((await t.check(s)).body.error.code, "provider_config_changed"); assert.equal(t.f.calls.length, count);
  } finally { await t.h.restart(t.bindings); }
});

test("lost response restores unknown across restart; explicit reconciliation reads the original receipt without another write", async () => {
  const s = await t.sample(), count = t.writes().length, key = crypto.randomUUID();
  t.f.modes.set("/cf/api/address_deletions", "lose-response");
  const lost = await t.remove(s, key); assert.equal(lost.status, 202, lost.text); assert.equal(lost.body.deletion.state, "unknown");
  await t.h.restart();
  assert.equal((await t.h.request(s.endpoint, { cookie: t.alice.cookie })).body.deletion.state, "unknown");
  assert.equal((await t.remove(s, key)).body.deletion.id, lost.body.deletion.id);
  assert.equal((await t.check(s)).body.deletion.state, "deleted"); assert.equal(t.writes().length, count + 1);
});
