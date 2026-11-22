import assert from "node:assert/strict";
import { test } from "node:test";
import PostalMime from "postal-mime";
import { normalSendFixture, smtpInput, SMTP_PASSWORD, mailInput } from "./normal-send-fixture.mjs";

test("ordinary SMTP: encrypted independent credentials, TLS, private Bcc MIME, durable no-repeat receipt and restart", async () => {
  const t = await normalSendFixture();
  try {
    const configKey = crypto.randomUUID(), saved = await t.configure(smtpInput, configKey);
    assert.equal(saved.status, 200, saved.text); assert.equal(saved.body.smtp.revision, 1);
    assert.equal(saved.text.includes(SMTP_PASSWORD), false);
    assert.equal((await t.configure(smtpInput, configKey)).body.replayed, true);
    const config = await t.h.db.prepare("SELECT * FROM normal_smtp_configs WHERE account_id=?").bind(t.id).first();
    assert.ok(config.credential_cipher); assert.equal(JSON.stringify(config).includes(SMTP_PASSWORD), false);
    const key = crypto.randomUUID(), input = { ...mailInput, cc: ["cc@example.test"], bcc: ["private@example.test"] };
    const sent = await t.send(input, key); assert.equal(sent.status, 201, sent.text);
    assert.equal(sent.body.outgoing.state, "accepted"); assert.equal(sent.body.outgoing.delivery, "unconfirmed"); assert.equal(sent.body.outgoing.retrySafe, false);
    assert.equal(t.opens.length, 1); assert.deepEqual(t.opens[0].options, { secureTransport: "on", allowHalfOpen: false });
    assert.equal(t.opens[0].address.port, 465); assert.equal(t.messages.length, 1);
    assert.match(t.writes.join(""), /RCPT TO:<private@example.test>/); assert.doesNotMatch(t.messages[0], /Bcc:|private@example.test/);
    const parsed = await PostalMime.parse(t.messages[0].replace(/\r\n\.\r\n$/, "\r\n"));
    assert.equal(parsed.subject, input.subject); assert.equal(parsed.from.address, "alice@example.test"); assert.match(parsed.text, /你好/);
    assert.equal((await t.send(input, key)).body.outgoing.id, sent.body.outgoing.id);
    assert.equal((await t.send({ ...input, text: "different" }, key)).status, 409);
    await t.h.restart(); assert.equal((await t.send(input, key)).body.outgoing.id, sent.body.outgoing.id); assert.equal(t.messages.length, 1);
    const read = await t.h.request(`${t.path}/outgoing?requestKey=${key}`, { cookie: t.alice.cookie }); assert.equal(read.body.outgoing.state, "accepted");
    const list = await t.h.request(`${t.path}/outgoing`, { cookie: t.alice.cookie }); assert.equal(list.body.items.length, 1);
  } finally { await t.close(); }
});

test("SMTP stage-aware failures never automatically repeat accepted or ambiguous DATA", async () => {
  for (const [mode, state, code, dataCount] of [["auth-reject", "rejected", "smtp_auth_failed", 0], ["rcpt-reject", "rejected", "smtp_recipient_rejected", 0],
    ["no-auth", "rejected", "smtp_auth_method_unavailable", 0], ["oversized-greeting", "rejected", "smtp_response_limit", 0],
    ["final-reject", "rejected", "smtp_message_rejected", 1], ["drop-final", "unknown", "smtp_outcome_unknown", 1], ["invalid-final", "unknown", "smtp_outcome_unknown", 1]]) {
    const t = await normalSendFixture();
    try {
      assert.equal((await t.configure()).status, 200); t.mode(mode); const key = crypto.randomUUID();
      const sent = await t.send(mailInput, key); assert.equal(sent.body.outgoing?.state, state, sent.text); assert.equal(sent.body.outgoing.error, code);
      assert.equal(sent.text.includes("secret-"), false); assert.equal(t.messages.length, dataCount);
      await t.send(mailInput, key); assert.equal(t.opens.length, 1); assert.equal(t.messages.length, dataCount);
    } finally { await t.close(); }
  }
});

test("SMTP deadlines are bounded and classified on opposite sides of DATA, without a retry connection", { timeout: 60000 }, async () => {
  for (const [mode, state, error] of [["stall-greeting", "rejected", "smtp_timeout"], ["stall-final", "unknown", "smtp_outcome_unknown"]]) {
    const t = await normalSendFixture();
    try {
      await t.configure(); t.mode(mode); const key = crypto.randomUUID(), started = Date.now();
      const result = await t.send(mailInput, key); assert.equal(result.body.outgoing?.state, state, result.text); assert.equal(result.body.outgoing.error, error);
      assert.ok(Date.now() - started < 18000); await t.send(mailInput, key); assert.equal(t.opens.length, 1);
    } finally { await t.close(); }
  }
});
