import assert from "node:assert/strict";
import { test } from "node:test";
import { newKey, seedMailbox } from "./runtime-harness.mjs";
import { normalSendFixture, smtpInput, smtpEndpoint, mailInput, SMTP_PASSWORD } from "./normal-send-fixture.mjs";

test("ordinary sending requires a new explicit scope; account reads/writes and temporary sends gain no authority", async () => {
  const t = await normalSendFixture();
  try {
    assert.equal((await t.configure()).status, 200);
    const bob = await t.h.register("smtp-private-bob");
    assert.equal((await t.send(mailInput, crypto.randomUUID(), { cookie: bob.cookie })).status, 404);
    for (const scopes of [["messages:send"], ["mail-accounts:write"], ["mail-accounts:read", "mail-accounts:sync"]]) {
      const key = await newKey(t.h, t.alice.cookie, { scopes });
      assert.equal((await t.send(mailInput, crypto.randomUUID(), { token: key.token, cookie: undefined })).status, 403);
    }
    assert.equal(t.opens.length, 0);
    assert.equal((await t.send(mailInput, crypto.randomUUID(), { origin: "https://evil.invalid" })).status, 403);
    const send = await newKey(t.h, t.alice.cookie, { scopes: ["mail-accounts:send"] });
    const sent = await t.send(mailInput, crypto.randomUUID(), { token: send.token, cookie: undefined, origin: null }); assert.equal(sent.status, 201, sent.text);
    assert.equal((await t.h.request(`${t.path}/outgoing`, { token: send.token })).status, 403);
    assert.equal((await t.h.request(`${t.path}/outgoing`, { cookie: bob.cookie })).body.items.length, 0);
  } finally { await t.close(); }
});

test("strict SMTP config and direct-send inputs do not leak credentials or permit arbitrary endpoints/senders/capabilities", async () => {
  const t = await normalSendFixture();
  try {
    for (const body of [{ ...smtpInput, hostname: "127.0.0.1" }, { ...smtpInput, endpointId: "missing" }, { ...smtpInput, username: "alice\r\nMAIL" },
      { ...smtpInput, password: "bad\0secret" }, { ...smtpInput, password: "\ud800" }, { ...smtpInput, password: undefined }, { ...smtpInput, smtpRevision: -1 }]) {
      assert.ok((await t.configure(body)).status >= 400);
    }
    await t.h.resetLimits(); assert.equal((await t.configure()).status, 200);
    for (const body of [{ ...mailInput, from: "spoof@example.test" }, { ...mailInput, draftId: crypto.randomUUID() }, { ...mailInput, attachments: "invalid" },
      { ...mailInput, scheduledAt: 123 }, { ...mailInput, subject: "bad\r\nBcc: leak" },
      { ...mailInput, subject: "\ud800" }, { ...mailInput, subject: "\ud800", text: "\udc00" },
      { ...mailInput, smtpRevision: 0 }, { ...mailInput, bcc: ["bad\r\nMAIL"] }]) assert.equal((await t.send(body)).status, 400);
    assert.equal(t.opens.length, 0);
    const row = await t.h.db.prepare("SELECT * FROM normal_smtp_configs WHERE account_id=?").bind(t.id).first();
    const ops = await t.h.db.prepare("SELECT * FROM normal_smtp_operations").all();
    assert.equal(JSON.stringify([row, ops]).includes(SMTP_PASSWORD), false);
    await t.h.restart({ SMTP_ENDPOINTS: JSON.stringify([{ ...smtpEndpoint, hostname: "smtp.other.test" }]) });
    assert.equal((await t.send()).body.error.code, "smtp_endpoint_changed");
    await t.h.restart({ SMTP_ENDPOINTS: JSON.stringify([{ ...smtpEndpoint, port: 25 }]) });
    assert.equal((await t.send()).body.error.code, "smtp_endpoints_unavailable");
    assert.equal(t.opens.length, 0);
  } finally { await t.close(); }
});

test("SMTP identity changes require new credentials; forget/delete erase secrets atomically but preserve send guards", async () => {
  const t = await normalSendFixture();
  try {
    await t.configure(); const key = crypto.randomUUID(), first = await t.send(mailInput, key); assert.equal(first.status, 201);
    assert.equal((await t.configure({ ...smtpInput, smtpRevision: 1, username: "Other", password: undefined })).body.error.code, "smtp_credential_required");
    const removed = await t.h.request(t.path, { method: "DELETE", cookie: t.alice.cookie, headers: { "idempotency-key": crypto.randomUUID() }, body: { expectedRevision: 1 } });
    assert.equal(removed.status, 200, removed.text);
    const row = await t.h.db.prepare("SELECT * FROM normal_smtp_configs WHERE account_id=?").bind(t.id).first();
    assert.equal(row.credential_cipher, null); assert.equal(row.enabled, 0);
    assert.equal((await t.send(mailInput, key)).body.outgoing.id, first.body.outgoing.id);
    assert.equal((await t.send()).status, 404); assert.equal(t.opens.length, 1);
    assert.equal((await t.h.request(`${t.path}/outgoing?requestKey=${key}`, { cookie: t.alice.cookie })).body.outgoing.state, "accepted");
  } finally { await t.close(); }
});

test("temporary and ordinary sends share recipient quota atomically and rejected attempts remain charged", async () => {
  const t = await normalSendFixture();
  try {
    await t.configure(); const mailbox = await seedMailbox(t.h, t.alice.id, "temp@example.test"), now = Math.floor(Date.now() / 1000);
    await t.h.db.prepare(`INSERT INTO outgoing_messages(id,user_id,mailbox_id,request_key,request_hash,provider_id,transport,from_address,to_address,subject,text_body,threading,state,created_at,updated_at,recipient_count)
      VALUES (?,?,?,?,'synthetic','synthetic-fixture','worker','temp@example.test','other@example.test','subject','text','none','rejected',?,?,2)`)
      .bind(crypto.randomUUID(), t.alice.id, mailbox, crypto.randomUUID(), now, now).run();
    assert.equal((await t.send({ ...mailInput, cc: ["cc@example.test"] })).body.error.code, "normal_send_reservation_denied"); assert.equal(t.opens.length, 0);
    t.mode("auth-reject"); assert.equal((await t.send()).body.outgoing.state, "rejected");
    assert.equal((await t.send()).body.error.code, "normal_send_reservation_denied"); assert.equal(t.opens.length, 1);
    assert.equal(await t.h.db.prepare("SELECT SUM(recipient_count) n FROM send_recipient_charges WHERE user_id=?").bind(t.alice.id).first("n"), 3);
  } finally { await t.close(); }
});
