import assert from "node:assert/strict";
import { test } from "node:test";
import { mailboxAccessFixture, assertReadOnlyProof } from "./mailbox-access-fixture.mjs";
import { newKey } from './runtime-harness.mjs';

test("credential proof imports a live empty mailbox through both production Workers and survives restart", async () => {
  const t = await mailboxAccessFixture();
  try {
    const remote = await t.upstream.create(), input = t.input(remote), key = crypto.randomUUID();
    const result = await t.recover(input, key); assert.equal(result.status, 201, result.text);
    const receipt = result.body.recovery;
    assert.equal(receipt.mode, "imported"); assert.equal(receipt.address, remote.address); assert.equal(receipt.requestKey, key);
    const stored = await t.h.db.prepare("SELECT * FROM mailboxes WHERE id=?").bind(receipt.mailboxId).first();
    assert.equal(stored.remote_id, String(remote.id)); assert.equal(stored.user_id, t.alice.id);
    assert.equal(stored.released_at, null); assert.equal(stored.disabled_at, null); assert.ok(stored.credential_cipher);
    assert.doesNotMatch(stored.credential_cipher, new RegExp(remote.jwt.replaceAll(".", "\\.")));
    assertReadOnlyProof(t, 1);
    await t.h.restart(); assert.deepEqual((await t.receipt(key)).body, result.body);
    assert.deepEqual((await t.recover(input, key)).body, result.body); assertReadOnlyProof(t, 1);
    assert.equal((await t.h.db.prepare("SELECT COUNT(*) n FROM mailbox_creations WHERE mailbox_id=?").bind(stored.id).first()).n, 1);
    assert.equal((await t.h.request(`/api/v1/mailbox-creations/${stored.id}`, { cookie: t.alice.cookie })).body.creation.origin, 'imported');
    await t.upstream.receive(remote.address);
    const sync = await t.h.request(`/api/v1/mailboxes/${stored.id}/sync`, { method: "POST", cookie: t.alice.cookie, body: {} });
    assert.equal(sync.status, 200, sync.text);
    assert.equal((await t.h.db.prepare("SELECT COUNT(*) n FROM messages WHERE mailbox_id=?").bind(stored.id).first()).n, 1);
    assert.doesNotMatch(JSON.stringify(result.body), new RegExp(remote.jwt.replaceAll(".", "\\.")));
  } finally { await t.close(); }
});

test("release recovery keeps the original mailbox, metadata, expiry and disabled state; replay cannot undo a later release", async () => {
  const t = await mailboxAccessFixture();
  try {
    const remote = await t.upstream.create(), input = t.input(remote), created = await t.recover(input);
    const id = created.body.recovery.mailboxId, path = `/api/v1/mailboxes/${id}`;
    await t.h.db.prepare("UPDATE mailboxes SET display_name='retained',note='note',favorite=1,paused=1,expires_at=unixepoch()+3600 WHERE id=?").bind(id).run();
    const release = () => t.h.request(`${path}/lifecycle`, { method: "POST", cookie: t.alice.cookie, body: { action: "release", confirmAddress: remote.address } });
    await release(); const before = await t.h.db.prepare("SELECT * FROM mailboxes WHERE id=?").bind(id).first();
    const key = crypto.randomUUID(), recovered = await t.recover(input, key); assert.equal(recovered.status, 200, recovered.text);
    assert.equal(recovered.body.recovery.mode, "restored"); assert.equal(recovered.body.recovery.mailboxId, id);
    const after = await t.h.db.prepare("SELECT * FROM mailboxes WHERE id=?").bind(id).first();
    for (const field of ["created_at", "expires_at", "display_name", "note", "favorite", "paused", "disabled_at"]) assert.equal(after[field], before[field], field);
    assert.equal(after.released_at, null); assert.ok(after.credential_cipher); assert.equal(after.sync_revision, before.sync_revision + 1);
    assert.equal((await t.h.request(`${path}/sync`, { method: "POST", cookie: t.alice.cookie, body: {} })).body.error.code, "mailbox_disabled");
    await release(); const released = await t.h.db.prepare("SELECT * FROM mailboxes WHERE id=?").bind(id).first();
    await t.recover(input, key); assert.deepEqual(await t.h.db.prepare("SELECT * FROM mailboxes WHERE id=?").bind(id).first(), released);
    assert.equal((await t.h.db.prepare("SELECT COUNT(*) n FROM mailbox_creations").first()).n, 1);
  } finally { await t.close(); }
});

test('minimal mailbox read/write API keys can import and reconcile without message reading or sending permissions', async () => {
  const t = await mailboxAccessFixture();
  try {
    const remote = await t.upstream.create(), input = t.input(remote), key = crypto.randomUUID();
    const caller = await newKey(t.h, t.alice.cookie, { scopes: ['mailboxes:read', 'mailboxes:write'] }), auth = { cookie: undefined, token: caller.token };
    const result = await t.recover(input, key, auth); assert.equal(result.status, 201, result.text);
    assert.deepEqual((await t.receipt(key, auth)).body, result.body);
    assert.equal((await t.h.request(`/api/v1/mailboxes/${result.body.recovery.mailboxId}/messages`, auth)).status, 403);
    assert.equal((await t.h.request(`/api/v1/mailboxes/${result.body.recovery.mailboxId}/outgoing`, { ...auth, method: 'POST', body: {} })).status, 403);
    assertReadOnlyProof(t, 1);
  } finally { await t.close(); }
});
