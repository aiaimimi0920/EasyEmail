import assert from "node:assert/strict";
import { test } from "node:test";
import { retentionFixture } from "./retention-fixture.mjs";
import { ok } from "./admin-fixture.mjs";
import { allocate, cfMail } from "./provider-fixture.mjs";
import { sendRequest, sendCalls } from "./send-fixture.mjs";
import { attachmentMail, binaryRequest, downloadPath } from "./attachment-fixture.mjs";

test("expiry is assigned only to new allocations, persists in guards, and is enforced before the scheduler", async () => {
  const a = await retentionFixture(), { h, f, alice } = a;
  try {
    const legacy = ok(await allocate(h, alice.cookie), 201).mailbox; assert.equal(legacy.expiresAt, null);
    ok(await a.policy({ enabled: true, mailboxDays: 1 }));
    const key = crypto.randomUUID();
    const box = ok(await allocate(h, alice.cookie, "self", { headers: { "idempotency-key": key } }), 201).mailbox;
    assert.equal(box.expiresAt, box.createdAt + 86400);
    assert.equal((await h.db.prepare("SELECT expires_at FROM mailbox_creations WHERE mailbox_id=?").bind(box.id).first()).expires_at, box.expiresAt);
    ok(await a.policy({ enabled: false }));
    const later = ok(await allocate(h, alice.cookie), 201).mailbox; assert.equal(later.expiresAt, null);
    await h.db.prepare("UPDATE mailboxes SET expires_at=unixepoch()-1 WHERE id=?").bind(box.id).run();
    const calls = f.calls.length;
    assert.equal((await h.request(`/api/v1/mailboxes/${box.id}`, { cookie: alice.cookie })).body.mailbox.expired, true);
    assert.equal((await h.request(`/api/v1/mailboxes/${box.id}/sync`, { cookie: alice.cookie, method: "POST", body: {} })).body.error.code, "mailbox_expired");
    assert.equal((await sendRequest(h, alice.cookie, box, crypto.randomUUID())).body.error.code, "mailbox_expired");
    assert.equal((await h.request(`/api/v1/mailboxes/${box.id}/lifecycle`, { cookie: alice.cookie, method: "POST", body: { action: "enable" } })).body.error.code, "mailbox_expired");
    const replay = await allocate(h, alice.cookie, "self", { headers: { "idempotency-key": key } });
    assert.equal(replay.body.mailbox.id, box.id); assert.equal(f.calls.length, calls);
    const run = ok(await a.run()).run; assert.equal(run.counts.expiredMailboxes, 1);
    const row = await h.db.prepare("SELECT * FROM mailboxes WHERE id=?").bind(box.id).first();
    assert.ok(row.expired_at); assert.equal(row.credential_cipher, null); assert.equal(row.released_at, null);
    assert.equal((await h.db.prepare("SELECT expires_at FROM mailboxes WHERE id=?").bind(legacy.id).first()).expires_at, null);
  } finally { await a.close(); }
});

test("expiry fences in-flight cache writes and attachment delivery; reserved sends retain their actual outcome", async () => {
  const a = await retentionFixture(), { h, f, alice } = a;
  let gate;
  try {
    const box = ok(await allocate(h, alice.cookie), 201).mailbox;
    f.messages.set(box.address, [cfMail(box.address, 1)]);
    gate = f.hold("/cf/api/parsed_mails");
    const sync = h.request(`/api/v1/mailboxes/${box.id}/sync`, { cookie: alice.cookie, method: "POST", body: {} });
    try { await gate.entered; await h.db.prepare("UPDATE mailboxes SET expires_at=unixepoch()-1 WHERE id=?").bind(box.id).run(); }
    finally { gate.release(); }
    assert.equal((await sync).body.error.code, "sync_lease_lost");
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM messages").first()).n, 0);
    // Direct fixture reset permits another independent boundary test without a production revival API.
    await h.db.prepare("UPDATE mailboxes SET expires_at=NULL WHERE id=?").bind(box.id).run();
    const fixture = attachmentMail(box.address); f.messages.set(box.address, [fixture.parsed]); f.rawMails.set(box.address, [fixture.raw]);
    ok(await h.request(`/api/v1/mailboxes/${box.id}/sync`, { cookie: alice.cookie, method: "POST", body: {} }));
    const message = (await h.request(`/api/v1/mailboxes/${box.id}/messages`, { cookie: alice.cookie })).body.items[0];
    gate = f.hold("/cf/api/mail/71"); const download = binaryRequest(h, downloadPath(box, message), alice.cookie);
    try { await gate.entered; await h.db.prepare("UPDATE mailboxes SET expires_at=unixepoch()-1 WHERE id=?").bind(box.id).run(); }
    finally { gate.release(); }
    assert.equal((await download).status, 409);
    const detail = await h.request(`/api/v1/mailboxes/${box.id}/messages/${message.id}`, { cookie: alice.cookie });
    assert.equal(detail.body.message.replyAddress, null);
    assert.equal(detail.body.message.attachmentDownloadAvailable, false);
    assert.ok(detail.body.message.attachments.every((item) => !item.downloadAvailable));
    await h.db.prepare("UPDATE mailboxes SET expires_at=NULL WHERE id=?").bind(box.id).run();
    const key = crypto.randomUUID(); gate = f.hold("/cf/admin/send_mail_by_binding");
    const sending = sendRequest(h, alice.cookie, box, key);
    try { await gate.entered; await h.db.prepare("UPDATE mailboxes SET expires_at=unixepoch()-1 WHERE id=?").bind(box.id).run(); ok(await a.run()); }
    finally { gate.release(); }
    assert.equal((await sending).body.outgoing.state, "accepted");
    assert.equal((await sendRequest(h, alice.cookie, box, key)).body.outgoing.state, "accepted");
    assert.equal(sendCalls(f).length, 1);
  } finally { gate?.release(); await a.close(); }
});

test("allocation snapshots cannot acquire a guard under a concurrently changed retention policy", async () => {
  const a = await retentionFixture(), { h, f, alice } = a;
  let gate;
  try {
    gate = f.hold("/v3/domains"); const pending = allocate(h, alice.cookie, "temporam");
    try { await gate.entered; ok(await a.policy({ enabled: true, mailboxDays: 1 })); }
    finally { gate.release(); }
    assert.equal((await pending).body.error.code, "retention_policy_changed");
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM mailbox_creations").first()).n, 0);
  } finally { gate?.release(); await a.close(); }
});
