import assert from "node:assert/strict";
import { before, after, beforeEach, test } from "node:test";
import { mailboxDeleteFixture } from "./mailbox-delete-fixture.mjs";
import { attachmentMail, binaryRequest, downloadPath } from "./attachment-fixture.mjs";
let t;
before(async () => { t = await mailboxDeleteFixture(); }, { timeout: 90000 });
beforeEach(async () => { await t.h.resetLimits(); t.f.modes.clear(); });
after(async () => { await t?.close(); }, { timeout: 15000 });
const send = (s) => t.h.request(`${s.path}/outgoing`, { method: "POST", cookie: t.alice.cookie, headers: { "idempotency-key": crypto.randomUUID() },
  body: { to: "recipient@example.test", subject: "Synthetic race", text: "Local fixture only" } });

test("concurrent same/different keys for one mailbox produce one durable reservation and at most one upstream write", async () => {
  for (const shared of [true, false]) {
    const s = await t.sample(), key = crypto.randomUUID(), count = t.writes().length;
    const results = await Promise.all(Array.from({ length: 4 }, () => t.remove(s, shared ? key : crypto.randomUUID())));
    assert.ok(results.every((row) => [200, 202].includes(row.status)), results.map((row) => row.text).join("\n"));
    assert.equal(new Set(results.map((row) => row.body.deletion.id)).size, 1); assert.equal(t.writes().length, count + 1);
    assert.equal((await t.h.db.prepare("SELECT COUNT(*) AS n FROM remote_mailbox_deletions WHERE mailbox_id=?").bind(s.box.id).first()).n, 1);
  }
});

test("an original POST may arrive after receipt 404; pending/unknown blocks new operations but never cancels or resends it", async () => {
  const s = await t.sample(), count = t.writes().length, gate = t.f.hold("/cf/api/address_deletions"), pending = t.remove(s);
  try {
    await gate.entered;
    assert.equal((await t.check(s)).body.deletion.state, "unknown");
    const sync = await t.h.request(`${s.path}/sync`, { method: "POST", cookie: t.alice.cookie, body: {} });
    assert.equal(sync.body.error.code, "mailbox_disabled"); assert.equal((await send(s)).body.error.code, "mailbox_disabled");
    assert.equal((await t.remove(s)).body.deletion.state, "unknown"); assert.equal(t.writes().length, count + 1);
  } finally { gate.release(); }
  assert.equal((await pending).body.deletion.state, "deleted");
  assert.equal((await t.h.request(s.endpoint, { cookie: t.alice.cookie })).body.deletion.state, "deleted");
});

test("an already reserved send blocks deletion until resolved; an unknown send never silently refunds or authorizes deletion", async () => {
  const s = await t.sample(), count = t.writes().length, gate = t.f.hold("/cf/api/send_mail"), pending = send(s);
  try {
    await gate.entered; assert.equal((await t.remove(s)).body.error.code, "mailbox_external_operation_unresolved");
    assert.equal(t.writes().length, count);
  } finally { gate.release(); }
  assert.equal((await pending).body.outgoing.state, "accepted"); assert.equal((await t.remove(s)).body.deletion.state, "deleted");
  const unknown = await t.sample(); t.f.modes.set("/cf/api/send_mail", 503);
  assert.equal((await send(unknown)).body.outgoing.state, "unknown");
  assert.equal((await t.remove(unknown)).body.error.code, "mailbox_external_operation_unresolved");
});

test("a release or provider revision change during capability preflight prevents reservation and delete dispatch", async () => {
  for (const change of ["release", "revision"]) {
    const s = await t.sample(), count = t.writes().length, gate = t.f.holdResponse("/cf/api/address_deletion_capability"), pending = t.remove(s);
    let result;
    try {
      await gate.entered;
      if (change === "release") await t.h.request(`${s.path}/lifecycle`, { method: "POST", cookie: t.alice.cookie,
        body: { action: "release", confirmAddress: s.box.address } });
      else {
        const config = JSON.parse(t.bindings.PROVIDER_CONFIG)[0];
        await t.h.db.prepare(`INSERT INTO provider_overrides(id,config_json,revision,secret_source,secret_cipher,change_token,updated_at)
          VALUES(?,?,1,'environment',NULL,?,unixepoch())`)
          .bind(config.id, JSON.stringify({ ...config, enabled: true }), crypto.randomUUID()).run();
      }
    } finally { gate.release(); result = await pending; }
    try {
      assert.equal(result.status, 409, result.text); assert.equal(t.writes().length, count);
      assert.equal(await t.h.db.prepare("SELECT id FROM remote_mailbox_deletions WHERE mailbox_id=?").bind(s.box.id).first(), null);
    } finally { if (change === "revision") await t.h.db.prepare("DELETE FROM provider_overrides").run(); }
  }
});

test("a late sync response cannot repopulate cache after the deletion reservation fenced its lease", async () => {
  const s = await t.sample(); await t.f.seed(s.box.address, s.remoteId);
  const gate = t.f.holdResponse("/cf/api/parsed_mails");
  const pending = t.h.request(`${s.path}/sync`, { method: "POST", cookie: t.alice.cookie, body: {} });
  try { await gate.entered; assert.equal((await t.remove(s)).body.deletion.state, "deleted"); }
  finally { gate.release(); }
  const result = await pending; assert.equal(result.body.error.code, "sync_lease_lost", result.text);
  assert.equal((await t.h.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE mailbox_id=?").bind(s.box.id).first()).n, 0);
});

test("a late verified attachment response never returns bytes after remote mailbox deletion", async () => {
  const s = await t.sample(), file = attachmentMail(s.box.address);
  await t.f.seed(s.box.address, s.remoteId, { ...file.parsed, fixture_raw: file.raw.raw });
  assert.equal((await t.h.request(`${s.path}/sync`, { method: "POST", cookie: t.alice.cookie, body: {} })).status, 200);
  const message = (await t.h.request(`${s.path}/messages`, { cookie: t.alice.cookie })).body.items[0];
  const gate = t.f.holdResponse(`/cf/api/mail/${s.remoteId}`), pending = binaryRequest(t.h, downloadPath(s.box, message), t.alice.cookie);
  try { await gate.entered; assert.equal((await t.remove(s)).body.deletion.state, "deleted"); }
  finally { gate.release(); }
  const result = await pending; assert.equal(result.status, 409, result.bytes.toString());
  assert.equal(JSON.parse(result.bytes).error.code, "mailbox_released");
});

test("explicit release/expiry clears credentials without cancelling an already admitted deletion or resurrecting access", async () => {
  for (const action of ["release", "expiry"]) {
    const s = await t.sample(), gate = t.f.hold("/cf/api/address_deletions"), pending = t.remove(s);
    try {
      await gate.entered;
      if (action === "release") await t.h.request(`${s.path}/lifecycle`, { method: "POST", cookie: t.alice.cookie,
        body: { action: "release", confirmAddress: s.box.address } });
      else { await t.h.db.prepare("UPDATE mailboxes SET expires_at=unixepoch()-1 WHERE id=?").bind(s.box.id).run(); await t.h.scheduled(); }
      assert.equal((await t.h.db.prepare("SELECT credential_cipher FROM mailboxes WHERE id=?").bind(s.box.id).first()).credential_cipher, null);
      assert.equal((await t.check(s)).body.error.code, "mailbox_credential_unavailable");
    } finally { gate.release(); }
    assert.equal((await pending).body.deletion.state, "deleted");
    assert.equal((await t.h.db.prepare("SELECT credential_cipher FROM mailboxes WHERE id=?").bind(s.box.id).first()).credential_cipher, null);
  }
});

test("a late lost POST response cannot regress a terminal result already reconciled by GET", async () => {
  const s = await t.sample(); t.f.modes.set("/cf/api/address_deletions", "lose-response");
  const gate = t.f.holdResponse("/cf/api/address_deletions"), pending = t.remove(s);
  let result, terminal;
  try {
    await gate.entered;
    assert.equal((await t.check(s)).body.deletion.state, "deleted");
    terminal = await t.h.db.prepare("SELECT * FROM remote_mailbox_deletions WHERE mailbox_id=?").bind(s.box.id).first();
  } finally { gate.release(); result = await pending; }
  assert.equal(result.body.deletion.state, "deleted");
  assert.deepEqual(await t.h.db.prepare("SELECT * FROM remote_mailbox_deletions WHERE mailbox_id=?").bind(s.box.id).first(), terminal);
  assert.equal((await t.h.db.prepare("SELECT credential_cipher FROM mailboxes WHERE id=?").bind(s.box.id).first()).credential_cipher, null);
});
