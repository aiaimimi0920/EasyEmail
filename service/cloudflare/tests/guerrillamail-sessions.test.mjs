import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createHarness } from "./runtime-harness.mjs";
import { guerrillaMail, guerrillamailFixture } from "./guerrillamail-fixture.mjs";

let h, f, alice, admin, mailbox;
const sync = () => h.request(`/api/v1/mailboxes/${mailbox.id}/sync`, { method: "POST", cookie: alice.cookie, body: {} });
const stored = () => h.db.prepare("SELECT * FROM mailboxes WHERE id=?").bind(mailbox.id).first();
const size = async () => (await h.db.prepare("SELECT COUNT(*) n FROM messages WHERE mailbox_id=?").bind(mailbox.id).first()).n;
before(async () => {
  f = await guerrillamailFixture(); h = await createHarness(f.bindings);
  alice = await h.register("guerrilla-session-alice"); admin = await h.register("guerrilla-session-admin");
  await h.db.prepare("INSERT INTO platform_admins VALUES (?,unixepoch())").bind(admin.id).run();
});
beforeEach(async () => {
  await h.resetLimits(); f.modes.clear(); f.replies.clear(); f.rotations.clear();
  const created = await h.request("/api/v1/mailboxes", { method: "POST", cookie: alice.cookie,
    headers: { "idempotency-key": crypto.randomUUID() }, body: { selection: "automatic" } });
  assert.equal(created.status, 201, created.text); mailbox = created.body.mailbox;
  f.messages.set(mailbox.address, [guerrillaMail(mailbox.address, 1), guerrillaMail(mailbox.address, 2)]);
});
after(async () => { await h?.close(); await f?.close(); });

test("list/detail token rotations are encrypted before the next provider call and survive restart without renewing an address", async () => {
  const before = await stored(), start = f.calls.length, initial = [...f.sessions.values()].find(row => row.address === mailbox.address).token;
  f.rotations.add("check_email"); f.rotations.add("fetch_email");
  const result = await sync(); assert.equal(result.status, 200, result.text); assert.equal(result.body.sync.inserted, 2);
  const calls = f.calls.slice(start), tokens = calls.map(call => call.query.get("sid_token"));
  assert.equal(calls[0].f, "check_email"); assert.equal(tokens[0], initial); assert.notEqual(tokens[1], tokens[0]); assert.notEqual(tokens[2], tokens[1]);
  const after = await stored(); assert.notEqual(after.credential_cipher, before.credential_cipher); assert.equal(after.sync_revision, before.sync_revision + 1);
  for (const value of tokens) assert.equal(after.credential_cipher.includes(value), false);
  await h.restart(); const count = f.calls.length; assert.equal((await sync()).status, 200);
  assert.equal(f.calls[count].query.get("sid_token"), tokens[2]); assert.equal((await size()), 2);
  assert.equal(f.calls.slice(start).some(call => ["get_email_address", "set_email_user"].includes(call.f)), false);
});

test("a failed cache transaction keeps the accepted session checkpoint but installs no messages or cursor", async () => {
  const before = await stored(); f.rotations.add("check_email");
  await h.db.prepare("CREATE TRIGGER guerrilla_cache_fail BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'synthetic'); END").run();
  try { assert.equal((await sync()).body.error.code, "sync_storage_failed"); }
  finally { await h.db.prepare("DROP TRIGGER guerrilla_cache_fail").run(); }
  const after = await stored(); assert.notEqual(after.credential_cipher, before.credential_cipher); assert.equal(after.sync_revision, before.sync_revision);
  assert.equal(await size(), 0); assert.equal(await h.db.prepare("SELECT * FROM provider_sync_cursors WHERE mailbox_id=?").bind(mailbox.id).first(), null);
  const count = f.calls.length; assert.equal((await sync()).status, 200); assert.equal(await size(), 2);
  assert.equal(f.calls[count].query.get("sid_token"), [...f.sessions.values()].find(row => row.address === mailbox.address).token);
});

test("failed credential checkpoint stops before details, preserves cache and does not recreate an expired/replaced session", async () => {
  const before = await stored(), start = f.calls.length; f.rotations.add("check_email");
  await h.db.prepare("CREATE TRIGGER guerrilla_checkpoint_fail BEFORE UPDATE OF credential_cipher ON mailboxes BEGIN SELECT RAISE(ABORT,'synthetic'); END").run();
  try { assert.equal((await sync()).body.error.code, "mailbox_credential_checkpoint_failed"); }
  finally { await h.db.prepare("DROP TRIGGER guerrilla_checkpoint_fail").run(); }
  assert.equal((await stored()).credential_cipher, before.credential_cipher); assert.equal(await size(), 0);
  assert.deepEqual(f.calls.slice(start).map(call => call.f), ["check_email"]);
  assert.equal((await sync()).body.error.code, "provider_session_changed");
  assert.equal(f.calls.slice(start).some(call => ["get_email_address", "set_email_user"].includes(call.f)), false);
});

test("late lease holders cannot checkpoint or dispatch detail reads for their rotated token", async () => {
  const before = await stored(), start = f.calls.length, gate = f.hold("check_email"); f.rotations.add("check_email"); const pending = sync();
  try { await gate.entered; await h.db.prepare("UPDATE mailboxes SET sync_token='successor',sync_lease_until=unixepoch()+60 WHERE id=?").bind(mailbox.id).run(); }
  finally { gate.release(); }
  assert.equal((await pending).body.error.code, "sync_lease_lost"); assert.equal((await stored()).credential_cipher, before.credential_cipher);
  assert.deepEqual(f.calls.slice(start).map(call => call.f), ["check_email"]); assert.equal(await size(), 0);
});

test("pause, disable, release, expiry, lease deadline, credential CAS and provider revision fence credential checkpoints", async () => {
  const changes = ["paused=1", "disabled_at=unixepoch()", "released_at=unixepoch()", "expires_at=unixepoch()-1", "sync_lease_until=unixepoch()-1",
    "credential_cipher='different-cipher'", "provider-revision"];
  for (const change of changes) {
    await h.resetLimits(); const before = await stored(), start = f.calls.length, gate = f.hold("check_email"); f.rotations.add("check_email"); const pending = sync();
    let checkpointCipher;
    try {
      await gate.entered;
      if (change === "provider-revision") {
        const saved = await h.request("/api/v1/admin/providers/guerrillamail", { method: "PUT", cookie: admin.cookie,
          body: { expectedRevision: 0, config: { ...f.config, enabled: false }, secretAction: "keep" } }); assert.equal(saved.status, 200, saved.text);
      } else await h.db.prepare(`UPDATE mailboxes SET ${change} WHERE id=?`).bind(mailbox.id).run();
      checkpointCipher = (await stored()).credential_cipher;
    } finally { gate.release(); }
    assert.equal((await pending).body.error.code, "sync_lease_lost", change); assert.equal((await stored()).credential_cipher, checkpointCipher);
    assert.equal(await size(), 0); assert.deepEqual(f.calls.slice(start).map(call => call.f), ["check_email"]);
    await h.db.prepare("DELETE FROM provider_overrides WHERE id='guerrillamail'").run();
    await h.db.prepare("UPDATE mailboxes SET paused=0,disabled_at=NULL,released_at=NULL,expires_at=NULL,sync_lease_until=NULL,sync_token=NULL,credential_cipher=? WHERE id=?")
      .bind(before.credential_cipher, mailbox.id).run();
    // Each rotation invalidated this test mailbox's old upstream token; only the fixture restores it for the next isolated fence case.
    const row = [...f.sessions.values()].find(row => row.address === mailbox.address);
    f.sessions.delete(row.token); row.token = f.calls[start].query.get("sid_token"); f.sessions.set(row.token, row);
  }
});

test("lease loss after a checkpoint keeps the new credential for the successor but cannot install late mail or cursor data", async () => {
  const before = await stored(), gate = f.hold("fetch_email"); f.rotations.add("check_email"); const pending = sync();
  let checkpoint;
  try {
    await gate.entered; checkpoint = (await stored()).credential_cipher; assert.notEqual(checkpoint, before.credential_cipher);
    await h.db.prepare("UPDATE mailboxes SET sync_token='successor',sync_lease_until=unixepoch()+60 WHERE id=?").bind(mailbox.id).run();
  } finally { gate.release(); }
  assert.equal((await pending).body.error.code, "sync_lease_lost"); assert.equal((await stored()).credential_cipher, checkpoint); assert.equal(await size(), 0);
  assert.equal(await h.db.prepare("SELECT * FROM provider_sync_cursors WHERE mailbox_id=?").bind(mailbox.id).first(), null);
});

test("bad detail identity/auth never checkpoints a token from a different mailbox or failed authorization", async () => {
  for (const patch of [{ mail_recipient: "foreign@guerrilla.example.test" }, { mail_id: "99" }, { auth: { success: false, error_codes: ["auth-token-invalid"] } }]) {
    await h.resetLimits(); const before = await stored();
    f.replies.set("fetch_email", { ...guerrillaMail(mailbox.address, 2), sid_token: "synthetic-untrusted-token", ...patch });
    assert.equal((await sync()).status, 502); assert.equal((await stored()).credential_cipher, before.credential_cipher); assert.equal(await size(), 0);
  }
});

test("admin public-session configuration rejects missing/Key mode and missing domains without pretending a platform Key exists", async () => {
  const save = config => h.request("/api/v1/admin/providers/guerrillamail", { method: "PUT", cookie: admin.cookie,
    body: { expectedRevision: 0, config, secretAction: "keep" } });
  const missing = { ...f.config }; delete missing.authentication;
  for (const config of [missing, { ...f.config, authentication: "api-key" }, { ...f.config, domains: [] }]) assert.equal((await save(config)).status, 400);
  assert.equal((await save(f.config)).status, 200); await h.restart();
  const row = (await h.request("/api/v1/admin/providers", { cookie: admin.cookie })).body.items[0];
  assert.equal(row.secret.configured, false); assert.equal(row.allocation.available, true); assert.equal(row.config.authentication, "anonymous");
});
