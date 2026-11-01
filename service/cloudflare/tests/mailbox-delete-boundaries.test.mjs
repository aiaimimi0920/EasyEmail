import assert from "node:assert/strict";
import { before, after, beforeEach, test } from "node:test";
import { mailboxDeleteFixture } from "./mailbox-delete-fixture.mjs";
import { providerFixture, allocate } from "./provider-fixture.mjs";
import { createHarness } from "./runtime-harness.mjs";
let t;
before(async () => { t = await mailboxDeleteFixture(); }, { timeout: 90000 });
beforeEach(async () => { await t.h.resetLimits(); t.f.modes.clear(); });
after(async () => { await t?.close(); }, { timeout: 15000 });

test("a changed generation or vanished address after preflight never deletes replacement or orphan mailbox data", async () => {
  for (const state of ["changed", "absent"]) {
    const s = await t.sample(); await t.f.seed(s.box.address, 810001 + (state === "changed" ? 1 : 0));
    const gate = t.f.hold("/cf/api/address_deletions"), pending = t.remove(s);
    let result, replacement, mail;
    try {
      await gate.entered;
      await t.f.db.prepare("DELETE FROM address WHERE id=?").bind(s.remoteId).run();
      if (state === "changed") {
        replacement = await t.f.db.prepare("INSERT INTO address(name) VALUES(?) RETURNING *").bind(s.box.address).first();
        assert.notEqual(replacement.id, s.remoteId);
      }
      mail = (await t.f.db.prepare("SELECT * FROM raw_mails WHERE address=?").bind(s.box.address).all()).results;
    } finally { gate.release(); result = await pending; }
    assert.equal(result.body.deletion.state, state, result.text);
    assert.equal(result.body.deletion.externalResourcesDeleted, false);
    assert.deepEqual((await t.f.db.prepare("SELECT * FROM raw_mails WHERE address=?").bind(s.box.address).all()).results, mail);
    if (replacement) assert.deepEqual(await t.f.db.prepare("SELECT * FROM address WHERE id=?").bind(replacement.id).first(), replacement);
    const saved = await t.h.db.prepare("SELECT credential_cipher,released_at FROM mailboxes WHERE id=?").bind(s.box.id).first();
    assert.equal(saved.credential_cipher, null); assert.ok(saved.released_at);
    assert.equal((await t.check(s)).body.deletion.state, state);
  }
});

async function trash(s) {
  await t.f.seed(s.box.address, s.remoteId);
  assert.equal((await t.h.request(`${s.path}/sync`, { method: "POST", cookie: t.alice.cookie, body: {} })).status, 200);
  const message = (await t.h.request(`${s.path}/messages`, { cookie: t.alice.cookie })).body.items[0];
  const path = `${s.path}/messages/${message.id}`;
  assert.equal((await t.h.request(path, { method: "DELETE", cookie: t.alice.cookie })).status, 200);
  return () => t.h.request(`${path}/remote-delete`, { method: "POST", cookie: t.alice.cookie,
    body: { confirmAddress: s.box.address, confirmMessageId: message.id }, headers: { "idempotency-key": crypto.randomUUID() } });
}

test("message and mailbox deletion reservations fence both directions; unknown message deletion remains a blocking guard", async () => {
  const first = await t.sample(), removeMail = await trash(first), gate = t.f.hold("/cf/api/mail_deletions"), pending = removeMail();
  let result;
  try {
    await gate.entered;
    assert.equal((await t.remove(first)).body.error.code, "mailbox_external_operation_unresolved");
  } finally { gate.release(); result = await pending; }
  assert.equal(result.body.deletion.state, "deleted"); assert.equal((await t.remove(first)).body.deletion.state, "deleted");
  const second = await t.sample(), blockedMail = await trash(second), next = t.f.hold("/cf/api/address_deletions"), removing = t.remove(second);
  const writes = t.f.calls.filter((call) => call.path === "/cf/api/mail_deletions" && call.method === "POST").length;
  try { await next.entered; assert.equal((await blockedMail()).body.error.code, "mailbox_disabled"); }
  finally { next.release(); result = await removing; }
  assert.equal(result.body.deletion.state, "deleted");
  assert.equal(t.f.calls.filter((call) => call.path === "/cf/api/mail_deletions" && call.method === "POST").length, writes);
  const third = await t.sample(), unknownMail = await trash(third); t.f.modes.set("/cf/api/mail_deletions", 503);
  assert.equal((await unknownMail()).body.deletion.state, "unknown");
  assert.equal((await t.remove(third)).body.error.code, "mailbox_external_operation_unresolved");
});

test("disabled mailboxes allow explicit deletion; expired/released mailboxes cannot admit new upstream writes", async () => {
  const disabled = await t.sample();
  assert.equal((await t.h.request(`${disabled.path}/lifecycle`, { method: "POST", cookie: t.alice.cookie, body: { action: "disable" } })).status, 200);
  assert.equal((await t.remove(disabled)).body.deletion.state, "deleted");
  for (const state of ["expired", "released"]) {
    const s = await t.sample(), count = t.f.calls.length;
    if (state === "expired") await t.h.db.prepare("UPDATE mailboxes SET expires_at=unixepoch()-1 WHERE id=?").bind(s.box.id).run();
    else await t.h.request(`${s.path}/lifecycle`, { method: "POST", cookie: t.alice.cookie,
      body: { action: "release", confirmAddress: s.box.address } });
    assert.equal((await t.remove(s)).body.error.code, `mailbox_${state}`);
    assert.equal(t.f.calls.length, count);
  }
});

test("Temporam and legacy Cloudflare never fall back to unconditional address deletion", async () => {
  const f = await providerFixture(); let h;
  try {
    h = await createHarness(f.bindings); const user = await h.register("legacy-mailbox-delete");
    for (const provider of ["temporam", "self"]) {
      const box = (await allocate(h, user.cookie, provider)).body.mailbox, count = f.calls.length;
      const result = await h.request(`/api/v1/mailboxes/${box.id}/remote-delete`, { method: "POST", cookie: user.cookie,
        body: { confirmAddress: box.address, confirmMailboxId: box.id }, headers: { "idempotency-key": crypto.randomUUID() } });
      assert.ok(result.status >= 400, result.text);
      assert.equal(await h.db.prepare("SELECT id FROM remote_mailbox_deletions WHERE mailbox_id=?").bind(box.id).first(), null);
      assert.equal(f.calls.slice(count).every((call) => call.method === "GET"), true);
    }
    assert.equal(f.calls.some((call) => call.method === "DELETE" || call.path === "/cf/api/address_deletions"), false);
  } finally { await h?.close(); await f.close(); }
});

test("stale pending projection is unknown without mutating evidence or contacting upstream", async () => {
  const s = await t.sample(); t.f.modes.set("/cf/api/address_deletions", 503);
  const removed = await t.remove(s);
  await t.h.db.prepare("UPDATE remote_mailbox_deletions SET state='pending',created_at=unixepoch()-61 WHERE id=?").bind(removed.body.deletion.id).run();
  const count = t.f.calls.length, row = await t.h.db.prepare("SELECT * FROM remote_mailbox_deletions WHERE mailbox_id=?").bind(s.box.id).first();
  const result = await t.h.request(s.endpoint, { cookie: t.alice.cookie });
  assert.equal(result.status, 202); assert.equal(result.body.deletion.state, "unknown"); assert.equal(result.body.deletion.retrySafe, false);
  assert.equal(t.f.calls.length, count);
  assert.deepEqual(await t.h.db.prepare("SELECT * FROM remote_mailbox_deletions WHERE mailbox_id=?").bind(s.box.id).first(), row);
});
