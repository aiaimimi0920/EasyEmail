import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createHarness, newKey } from "./runtime-harness.mjs";
import { allocate, cfMail } from "./provider-fixture.mjs";
import { sendFixture, sendBody, sendCalls, sendRequest } from "./send-fixture.mjs";

let h, f, alice, bob, box, other, temp;
before(async () => {
  f = await sendFixture(); h = await createHarness(f.bindings);
  alice = await h.register("send-alice"); bob = await h.register("send-bob");
  box = (await allocate(h, alice.cookie)).body.mailbox;
  other = (await allocate(h, bob.cookie)).body.mailbox;
  temp = (await allocate(h, alice.cookie, "temporam")).body.mailbox;
});
beforeEach(async () => {
  await h.resetLimits(); await h.db.prepare("DELETE FROM outgoing_messages").run(); f.modes.clear();
});
after(async () => { await h?.close(); await f?.close(); });

test("send is independently scoped, owner-bound and Origin-protected; arbitrary send fields are refused", async () => {
  const count = sendCalls(f).length;
  const key = await newKey(h, alice.cookie, { scopes: ["mailboxes:write", "messages:write", "messages:read"] });
  assert.equal((await sendRequest(h, null, box, crypto.randomUUID(), sendBody, { token: key.token })).status, 403);
  assert.equal((await sendRequest(h, bob.cookie, box, crypto.randomUUID())).status, 404);
  assert.equal((await sendRequest(h, alice.cookie, other, crypto.randomUUID())).status, 404);
  assert.equal((await sendRequest(h, alice.cookie, box, crypto.randomUUID(), sendBody, { origin: null })).status, 403);
  for (const body of [{ ...sendBody, from: other.address }, { ...sendBody, headers: {} }, { ...sendBody, html: "<b>hi</b>" },
    { ...sendBody, to: "a@example.test,b@example.test" }, { ...sendBody, to: "A <a@example.test>" },
    { ...sendBody, subject: "injected\r\nBcc: victim@example.test" }, { ...sendBody, text: "" }, { ...sendBody, replyToMessageId: crypto.randomUUID() }]) {
    assert.equal((await sendRequest(h, alice.cookie, box, crypto.randomUUID(), body)).status, 400);
  }
  assert.equal((await sendRequest(h, alice.cookie, temp, crypto.randomUUID())).body.error.code, "sending_disabled");
  assert.equal(sendCalls(f).length, count);
});

test("accepted is durable, not delivered; same key replays once across restart and payload changes conflict", async () => {
  const key = crypto.randomUUID(), count = sendCalls(f).length;
  const writer = await newKey(h, alice.cookie, { scopes: ["messages:send"] });
  const result = await sendRequest(h, null, box, key, sendBody, { token: writer.token, origin: null });
  assert.equal(result.status, 201, result.text);
  assert.equal(result.body.outgoing.state, "accepted");
  assert.equal(result.body.outgoing.delivery, "unconfirmed");
  assert.equal(result.body.outgoing.retrySafe, false);
  const call = sendCalls(f).at(-1);
  assert.deepEqual(call.body, { from: box.address, to: [sendBody.to], subject: sendBody.subject, text: sendBody.text });
  assert.equal(call.headers["x-admin-auth"], "synthetic-cf-admin");
  assert.equal(result.text.includes("synthetic-cf-admin"), false);
  assert.equal((await sendRequest(h, alice.cookie, box, key, { ...sendBody, text: "changed" })).status, 409);
  await h.restart();
  assert.equal((await sendRequest(h, alice.cookie, box, key)).body.outgoing.id, result.body.outgoing.id);
  assert.equal(sendCalls(f).length, count + 1);
  const id = result.body.outgoing.id;
  assert.equal((await h.request(`/api/v1/outgoing/${id}`, { token: writer.token })).status, 403);
  assert.equal((await h.request(`/api/v1/outgoing/${id}`, { cookie: bob.cookie })).status, 404);
  assert.equal((await h.request(`/api/v1/outgoing/${id}`, { cookie: alice.cookie })).body.outgoing.text, sendBody.text);
  assert.equal((await h.request("/api/v1/outgoing", { cookie: bob.cookie })).body.items.length, 0);
});

test("concurrent duplicate stays pending and never dispatches twice; stale pending is unknown, not retryable", async () => {
  const key = crypto.randomUUID(), count = sendCalls(f).length, gate = f.hold("/cf/admin/send_mail_by_binding");
  const pending = sendRequest(h, alice.cookie, box, key);
  try {
    await gate.entered;
    const replay = await sendRequest(h, alice.cookie, box, key);
    assert.equal(replay.status, 202); assert.equal(replay.body.outgoing.state, "pending");
  } finally { gate.release(); }
  assert.equal((await pending).body.outgoing.state, "accepted");
  assert.equal(sendCalls(f).length, count + 1);
  await h.db.prepare("UPDATE outgoing_messages SET state = 'pending', created_at = unixepoch() - 120 WHERE request_key = ?").bind(key).run();
  const before = await h.db.prepare("SELECT state FROM outgoing_messages WHERE request_key = ?").bind(key).first();
  assert.equal((await h.request("/api/v1/outgoing", { cookie: alice.cookie })).body.items[0].state, "unknown");
  assert.equal((await h.db.prepare("SELECT state FROM outgoing_messages WHERE request_key = ?").bind(key).first()).state, before.state, "GET is read-only");
  await h.scheduled();
  assert.equal((await sendRequest(h, alice.cookie, box, key)).body.outgoing.state, "unknown");
  assert.equal(sendCalls(f).length, count + 1);
});

test("400, 5xx, redirects, malformed/oversized responses and disconnects remain unknown without fallback", async () => {
  for (const mode of [400, 500, "redirect", "invalid", "oversized", "disconnect", 201]) {
    f.modes.set("/cf/admin/send_mail_by_binding", mode);
    await h.db.prepare("DELETE FROM outgoing_messages").run();
    const key = crypto.randomUUID(), count = sendCalls(f).length;
    const result = await sendRequest(h, alice.cookie, box, key);
    assert.equal(result.status, 202, `${mode}: ${result.text}`); assert.equal(result.body.outgoing.state, "unknown");
    assert.equal((await sendRequest(h, alice.cookie, box, key)).body.outgoing.state, "unknown");
    assert.equal(sendCalls(f).length, count + 1);
    assert.equal(f.calls.some((call) => call.path === "/secret-exfiltration"), false);
  }
});

test("explicit middleware rejection is recorded and also never retried", async () => {
  for (const mode of [401, 403, 429]) {
    f.modes.set("/cf/admin/send_mail_by_binding", mode);
    const key = crypto.randomUUID(), count = sendCalls(f).length;
    const result = await sendRequest(h, alice.cookie, box, key);
    assert.equal(result.body.outgoing.state, "rejected", result.text);
    assert.equal((await sendRequest(h, alice.cookie, box, key)).body.outgoing.state, "rejected");
    assert.equal(sendCalls(f).length, count + 1);
  }
});

test("atomic reservations enforce per-user minute and global daily limits including unknown attempts", async () => {
  const count = sendCalls(f).length;
  const results = await Promise.all(Array.from({ length: 6 }, () => sendRequest(h, alice.cookie, box, crypto.randomUUID())));
  assert.equal(results.filter((result) => result.body.outgoing?.state === "accepted").length, 3);
  assert.equal(results.filter((result) => result.body.error?.code === "send_quota_exceeded").length, 3);
  assert.equal(sendCalls(f).length, count + 3);
  await h.db.prepare("DELETE FROM outgoing_messages").run();
  const template = (await sendRequest(h, alice.cookie, box, crypto.randomUUID())).body.outgoing;
  const row = await h.db.prepare("SELECT * FROM outgoing_messages WHERE id = ?").bind(template.id).first();
  await h.db.prepare("UPDATE outgoing_messages SET created_at = MAX(unixepoch() - 61, CAST(unixepoch() / 86400 AS INTEGER) * 86400)").run();
  const columns = Object.keys(row);
  for (let i = 1; i < 200; i++) {
    const copy = { ...row, id: crypto.randomUUID(), request_key: crypto.randomUUID(), user_id: bob.id, mailbox_id: other.id,
      created_at: Math.floor(Date.now() / 86400000) * 86400, state: "unknown" };
    await h.db.prepare(`INSERT INTO outgoing_messages (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
      .bind(...columns.map((column) => copy[column])).run();
  }
  assert.equal((await sendRequest(h, alice.cookie, box, crypto.randomUUID())).body.error.code, "send_quota_exceeded");
});

test("post-send D1 failure is unknown and a replay does not duplicate the external write", async () => {
  const count = sendCalls(f).length, key = crypto.randomUUID();
  await h.db.exec("CREATE TRIGGER fail_accept BEFORE UPDATE ON outgoing_messages WHEN NEW.state = 'accepted' BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END");
  try {
    const result = await sendRequest(h, alice.cookie, box, key);
    assert.equal(result.status, 202, result.text); assert.equal(result.body.outgoing.state, "unknown");
    assert.equal(result.body.outgoing.error, "send_storage_failed");
  } finally { await h.db.exec("DROP TRIGGER fail_accept"); }
  assert.equal((await sendRequest(h, alice.cookie, box, key)).body.outgoing.state, "unknown");
  assert.equal(sendCalls(f).length, count + 1);
});

test("reply headers come only from the same mailbox cached valid RFC Message-ID", async () => {
  f.messages.set(box.address, [{ ...cfMail(box.address, 91), message_id: "<reply-source@example.test>" }]);
  assert.equal((await h.request(`/api/v1/mailboxes/${box.id}/sync`, { method: "POST", cookie: alice.cookie, body: {} })).status, 200);
  const source = (await h.request(`/api/v1/mailboxes/${box.id}/messages`, { cookie: alice.cookie })).body.items[0];
  const result = await sendRequest(h, alice.cookie, box, crypto.randomUUID(), { ...sendBody, replyToMessageId: source.id });
  assert.equal(result.body.outgoing.threading, "submitted", result.text);
  assert.deepEqual(sendCalls(f).at(-1).body.headers, { "In-Reply-To": "<reply-source@example.test>", References: "<reply-source@example.test>" });
  assert.equal((await sendRequest(h, bob.cookie, other, crypto.randomUUID(), { ...sendBody, replyToMessageId: source.id })).status, 400);
});

test("outgoing pagination is owner-bound, time ordered and complete even when all timestamps tie", async () => {
  const initial = await sendRequest(h, alice.cookie, box, crypto.randomUUID());
  const row = await h.db.prepare("SELECT * FROM outgoing_messages WHERE id = ?").bind(initial.body.outgoing.id).first();
  const columns = Object.keys(row), expected = [row.id];
  for (let i = 0; i < 28; i++) {
    const id = crypto.randomUUID(); expected.push(id);
    const copy = { ...row, id, request_key: crypto.randomUUID(), subject: `history-${i}` };
    await h.db.prepare(`INSERT INTO outgoing_messages (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
      .bind(...columns.map((column) => copy[column])).run();
  }
  const ids = []; let cursor = "";
  do {
    const page = await h.request(`/api/v1/outgoing?limit=7${cursor ? `&cursor=${cursor}` : ""}`, { cookie: alice.cookie });
    assert.equal(page.status, 200, page.text);
    assert.equal(page.body.items.some((item) => "text" in item || "request_hash" in item), false);
    ids.push(...page.body.items.map((item) => item.id)); cursor = page.body.nextCursor;
  } while (cursor);
  assert.deepEqual(ids, expected.sort().reverse()); assert.equal(new Set(ids).size, 29);
  assert.equal((await h.request(`/api/v1/outgoing?cursor=${row.id}`, { cookie: bob.cookie })).status, 400);
});

test("even failure to persist unknown retains a durable pending guard and prevents another dispatch", async () => {
  const key = crypto.randomUUID(), count = sendCalls(f).length;
  await h.db.exec("CREATE TRIGGER fail_all_send_updates BEFORE UPDATE ON outgoing_messages BEGIN SELECT RAISE(ABORT, 'synthetic storage unavailable'); END");
  try {
    const result = await sendRequest(h, alice.cookie, box, key);
    assert.equal(result.status, 202); assert.equal(result.body.outgoing.state, "unknown");
    assert.equal((await sendRequest(h, alice.cookie, box, key)).status, 202);
  } finally { await h.db.exec("DROP TRIGGER fail_all_send_updates"); }
  await h.restart();
  assert.equal((await sendRequest(h, alice.cookie, box, key)).status, 202);
  assert.equal(sendCalls(f).length, count + 1);
});
