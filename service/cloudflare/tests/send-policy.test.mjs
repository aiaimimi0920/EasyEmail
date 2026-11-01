import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "./runtime-harness.mjs";
import { allocate, cfMail, providerFixture } from "./provider-fixture.mjs";
import { sendFixture, sendBody, sendCalls, sendRequest } from "./send-fixture.mjs";
import { seedLegacyCloudflare } from "./legacy-mailbox-fixture.mjs";

test("sending is off by default, requires explicit recipient policy, and server allowlists fail closed", async () => {
  const f = await providerFixture(); const h = await createHarness(f.bindings);
  try {
    const user = await h.register("send-policy-alice"); const box = (await allocate(h, user.cookie)).body.mailbox;
    assert.equal((await h.request("/api/v1/providers", { cookie: user.cookie })).body.items[0].capabilities.send, false);
    assert.equal((await sendRequest(h, user.cookie, box, crypto.randomUUID())).body.error.code, "sending_disabled");
    const config = JSON.parse(f.bindings.PROVIDER_CONFIG);
    for (const settings of [{ sendTransport: "binding" }, { sendTransport: "binding", sendRecipients: [] }]) {
      await h.restart({ PROVIDER_CONFIG: JSON.stringify([{ ...config[0], ...settings }, config[1]]) });
      assert.equal((await sendRequest(h, user.cookie, box, crypto.randomUUID())).body.error.code, "sending_disabled");
    }
    for (const settings of [{ sendTransport: "admin" }, { sendTransport: "binding", sendRecipients: ["*", "a@example.test"] },
      { sendTransport: "worker", sendRecipients: ["injected\r\n@example.test"] }]) {
      await h.restart({ PROVIDER_CONFIG: JSON.stringify([{ ...config[0], ...settings }, config[1]]) });
      assert.equal((await h.request("/api/v1/providers", { cookie: user.cookie })).status, 503);
    }
    await h.restart({ PROVIDER_CONFIG: JSON.stringify([{ ...config[0], sendTransport: "binding", sendRecipients: ["allowed@example.test"] }, config[1]]) });
    assert.equal((await sendRequest(h, user.cookie, box, crypto.randomUUID())).body.error.code, "recipient_not_allowed");
    assert.equal(sendCalls(f).length, 0);
    assert.equal((await sendRequest(h, user.cookie, box, crypto.randomUUID(), { ...sendBody, to: "allowed@example.test" })).body.outgoing.state, "accepted");
  } finally { await h.close(); await f.close(); }
});

test("worker mode uses mailbox JWT only and declares thread headers unavailable", async () => {
  const f = await sendFixture("worker"); const h = await createHarness(f.bindings);
  try {
    const user = await h.register("send-worker-alice"); const box = (await allocate(h, user.cookie)).body.mailbox;
    f.messages.set(box.address, [{ ...cfMail(box.address, 1), message_id: "<source@example.test>" }]);
    await h.request(`/api/v1/mailboxes/${box.id}/sync`, { cookie: user.cookie, method: "POST", body: {} });
    const source = (await h.request(`/api/v1/mailboxes/${box.id}/messages`, { cookie: user.cookie })).body.items[0];
    const result = await sendRequest(h, user.cookie, box, crypto.randomUUID(), { ...sendBody, replyToMessageId: source.id });
    assert.equal(result.body.outgoing.threading, "unavailable", result.text);
    assert.equal(sendCalls(f).at(-1).path, "/cf/api/send_mail");
    assert.deepEqual(sendCalls(f).at(-1).body, { from_name: "", to_mail: sendBody.to, to_name: "", subject: sendBody.subject, content: sendBody.text, is_html: false });
    const count = sendCalls(f).length;
    const gate = f.hold("/cf/api/send_mail");
    const key = crypto.randomUUID(), pending = sendRequest(h, user.cookie, box, key);
    try { await gate.entered; await new Promise((resolve) => setTimeout(resolve, 15300)); }
    finally { gate.release(); }
    assert.equal((await pending).body.outgoing.state, "unknown");
    assert.equal((await sendRequest(h, user.cookie, box, key)).body.outgoing.state, "unknown");
    assert.equal(sendCalls(f).length, count + 1);
  } finally { await h.close(); await f.close(); }
});

test("M3a expand and RFC metadata backfill preserve cache identity and organization without duplicates", async () => {
  const f = await sendFixture(); const h = await createHarness(f.bindings, false, "0003_organization.sql");
  try {
    const user = await h.register("send-upgrade-alice"), box = await seedLegacyCloudflare(h, f, user.id);
    const remote = cfMail(box.address, 1), id = crypto.randomUUID();
    const content = { remoteId: "1", recipient: box.address, sender: remote.sender, subject: remote.subject,
      textBody: remote.text, htmlBody: remote.html, attachments: remote.attachments,
      receivedAt: Math.floor(Date.parse("2026-10-28T01:00:00Z") / 1000) };
    const hash = (await import("node:crypto")).createHash("sha256").update(JSON.stringify(content)).digest("hex");
    await h.db.prepare(`INSERT INTO messages
      (id,user_id,mailbox_id,remote_id,fingerprint,sender,recipient,subject,text_body,html_body,attachments,received_at,observed_at,is_read,starred,archived)
      VALUES (?,?,?,'1',?,?,?,?,?,?,?,?,123,1,1,1)`)
      .bind(id, user.id, box.id, hash, remote.sender, box.address, remote.subject, remote.text, remote.html, JSON.stringify(remote.attachments), content.receivedAt).run();
    const before = await h.db.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
    await h.migrate(); await h.migrate();
    f.messages.set(box.address, [{ ...remote, message_id: "<upgrade@example.test>" }]);
    const sync = await h.request(`/api/v1/mailboxes/${box.id}/sync`, { method: "POST", cookie: user.cookie, body: {} });
    assert.equal(sync.body.sync.inserted, 0, sync.text);
    const after = await h.db.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
    for (const [key, value] of Object.entries(before)) assert.equal(after[key], value, key);
    assert.equal(after.rfc_message_id, "<upgrade@example.test>");
    assert.equal((await h.db.prepare("SELECT COUNT(*) AS n FROM messages").first()).n, 1);
    f.messages.set(box.address, [{ ...remote, message_id: "<evil@example.test>\r\nBcc: victim@example.test" }]);
    assert.equal((await h.request(`/api/v1/mailboxes/${box.id}/sync`, { method: "POST", cookie: user.cookie, body: {} })).body.sync.inserted, 0);
    assert.equal((await h.db.prepare("SELECT rfc_message_id FROM messages WHERE id = ?").bind(id).first()).rfc_message_id, "<upgrade@example.test>");
  } finally { await h.close(); await f.close(); }
});

test("UTC user daily and rolling platform minute quotas cannot be bypassed by fresh keys", async () => {
  const f = await sendFixture(), h = await createHarness(f.bindings);
  try {
    const user = await h.register("send-daily-alice"), other = await h.register("send-daily-bob");
    const box = (await allocate(h, user.cookie)).body.mailbox, otherBox = (await allocate(h, other.cookie)).body.mailbox;
    const first = await sendRequest(h, user.cookie, box, crypto.randomUUID());
    const row = await h.db.prepare("SELECT * FROM outgoing_messages WHERE id = ?").bind(first.body.outgoing.id).first();
    const columns = Object.keys(row);
    const insert = async (extra) => {
      const copy = { ...row, id: crypto.randomUUID(), request_key: crypto.randomUUID(), ...extra };
      await h.db.prepare(`INSERT INTO outgoing_messages (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
        .bind(...columns.map((column) => copy[column])).run();
    };
    const dayStart = Math.floor(Date.now() / 86400000) * 86400;
    for (let i = 1; i < 20; i++) await insert({ created_at: dayStart });
    const count = sendCalls(f).length;
    assert.equal((await sendRequest(h, user.cookie, box, crypto.randomUUID())).body.error.code, "send_quota_exceeded");
    assert.equal(sendCalls(f).length, count);
    await h.db.prepare("DELETE FROM outgoing_messages").run();
    for (let i = 0; i < 10; i++) await insert({ user_id: other.id, mailbox_id: otherBox.id, created_at: Math.floor(Date.now() / 1000) });
    assert.equal((await sendRequest(h, user.cookie, box, crypto.randomUUID())).body.error.code, "send_quota_exceeded");
    assert.equal(sendCalls(f).length, count);
  } finally { await h.close(); await f.close(); }
});
