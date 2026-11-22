import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "./runtime-harness.mjs";
import { allocate } from "./provider-fixture.mjs";
import { attachmentMail, binaryRequest, downloadPath } from "./attachment-fixture.mjs";
import { sendFixture, sendRequest, sendCalls } from "./send-fixture.mjs";

async function scenario(name, run) {
  const f = await sendFixture(), h = await createHarness(f.bindings);
  try {
    const user = await h.register(name), headers = { "idempotency-key": crypto.randomUUID() };
    const box = (await allocate(h, user.cookie, "self", { headers })).body.mailbox;
    const fixture = attachmentMail(box.address);
    f.messages.set(box.address, [fixture.parsed]); f.rawMails.set(box.address, [fixture.raw]);
    const sync = () => h.request(`/api/v1/mailboxes/${box.id}/sync`, { method: "POST", cookie: user.cookie, body: {} });
    assert.equal((await sync()).status, 200);
    const message = (await h.request(`/api/v1/mailboxes/${box.id}/messages`, { cookie: user.cookie })).body.items[0];
    const life = (action, body = {}) => h.request(`/api/v1/mailboxes/${box.id}/lifecycle`, {
      method: "POST", cookie: user.cookie, body: { action, ...(action === "release" ? { confirmAddress: box.address } : {}), ...body } });
    await run({ h, f, user, box, message, fixture, sync, life, headers });
  } finally { await h.close(); await f.close(); }
}

test("disable and purge revalidate before returning an in-flight attachment; no binary escapes after the transition", async () => {
  await scenario("lifecycle-download-races", async ({ h, f, user, box, message, life }) => {
    let gate = f.hold("/cf/api/mail/71"), pending = binaryRequest(h, downloadPath(box, message), user.cookie);
    try { await gate.entered; assert.equal((await life("disable")).status, 200); }
    finally { gate.release(); }
    const disabled = await pending;
    assert.equal(disabled.status, 409); assert.equal(JSON.parse(disabled.bytes).error.code, "mailbox_disabled");
    assert.equal((await life("enable")).status, 200);
    gate = f.hold("/cf/api/mail/71"); pending = binaryRequest(h, downloadPath(box, message), user.cookie);
    try {
      await gate.entered;
      const base = `/api/v1/mailboxes/${box.id}/messages/${message.id}`;
      assert.equal((await h.request(base, { method: "DELETE", cookie: user.cookie })).status, 200);
      assert.equal((await h.request(`${base}/purge`, { method: "POST", cookie: user.cookie, body: { confirmMessageId: message.id } })).status, 200);
    } finally { gate.release(); }
    assert.equal((await pending).status, 404);
  });
});

test("no-op lifecycle requests preserve a fresh sync lease and independent pause state", async () => {
  await scenario("lifecycle-noop-lease", async ({ h, f, user, box, fixture, sync, life }) => {
    f.messages.set(box.address, [{ ...fixture.parsed, id: 72 }]);
    const gate = f.hold("/cf/api/parsed_mails"), pending = sync();
    try { await gate.entered; assert.equal((await life("enable")).status, 200); }
    finally { gate.release(); }
    assert.equal((await pending).body.sync.inserted, 1);
    await h.request(`/api/v1/mailboxes/${box.id}`, { method: "PATCH", cookie: user.cookie, body: { paused: true } });
    const first = await life("disable"), second = await life("disable");
    assert.equal(first.body.mailbox.disabledAt, second.body.mailbox.disabledAt);
    const enabled = await life("enable");
    assert.equal(enabled.body.mailbox.paused, true);
    assert.equal((await sync()).body.error.code, "mailbox_paused");
    for (const action of [{ toString: null }, [], null, 1, "invalid"]) assert.equal((await life(action)).status, 400);
  });
});

test("D1 failure leaves credentials and cached content intact; release replay cannot create another mailbox", async () => {
  await scenario("lifecycle-storage-atomic", async ({ h, user, box, message, life, headers, f }) => {
    const before = await h.db.prepare("SELECT * FROM mailboxes WHERE id=?").bind(box.id).first();
    await h.db.prepare("CREATE TRIGGER fail_release BEFORE UPDATE OF released_at ON mailboxes BEGIN SELECT RAISE(ABORT, 'synthetic release failure'); END").run();
    try { assert.equal((await life("release")).status, 500); }
    finally { await h.db.prepare("DROP TRIGGER fail_release").run(); }
    assert.deepEqual(await h.db.prepare("SELECT * FROM mailboxes WHERE id=?").bind(box.id).first(), before);
    const base = `/api/v1/mailboxes/${box.id}/messages/${message.id}`;
    await h.request(base, { method: "DELETE", cookie: user.cookie });
    const cached = await h.db.prepare("SELECT * FROM messages WHERE id=?").bind(message.id).first();
    await h.db.prepare("CREATE TRIGGER fail_purge BEFORE UPDATE OF purged_at ON messages BEGIN SELECT RAISE(ABORT, 'synthetic purge failure'); END").run();
    try { assert.equal((await h.request(`${base}/purge`, { method: "POST", cookie: user.cookie, body: { confirmMessageId: message.id } })).status, 500); }
    finally { await h.db.prepare("DROP TRIGGER fail_purge").run(); }
    assert.deepEqual(await h.db.prepare("SELECT * FROM messages WHERE id=?").bind(message.id).first(), cached);
    assert.equal((await life("release")).status, 200);
    const count = f.calls.length;
    const replay = await allocate(h, user.cookie, "self", { headers });
    assert.equal(replay.status, 200); assert.equal(replay.body.mailbox.id, box.id); assert.ok(replay.body.mailbox.releasedAt);
    assert.equal(f.calls.length, count);
  });
});

test("release does not cancel or repeat a previously reserved send, and the immutable guard remains replayable", async () => {
  await scenario("lifecycle-inflight-send", async ({ h, f, user, box, life }) => {
    const gate = f.hold("/cf/admin/send_mail_by_binding"), key = crypto.randomUUID();
    const pending = sendRequest(h, user.cookie, box, key);
    try {
      await gate.entered;
      assert.equal((await h.db.prepare("SELECT state FROM outgoing_messages LIMIT 1").first()).state, "pending");
      assert.equal((await life("release")).status, 200);
    } finally { gate.release(); }
    const result = await pending;
    assert.equal(result.body.outgoing.state, "accepted");
    await h.restart();
    assert.equal((await sendRequest(h, user.cookie, box, key)).body.outgoing.id, result.body.outgoing.id);
    assert.equal(sendCalls(f).length, 1);
    assert.equal((await sendRequest(h, user.cookie, box, crypto.randomUUID())).body.error.code, "mailbox_released");
  });
});
