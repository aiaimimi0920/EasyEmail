import assert from "node:assert/strict";
import { test } from "node:test";
import { normalSendFixture, smtpInput, mailInput } from "./normal-send-fixture.mjs";

test("SMTP config CAS and same-key sending serialize once; an in-flight duplicate only reads its durable guard", async () => {
  const t = await normalSendFixture(); let gate;
  try {
    const configKey = crypto.randomUUID(), configs = await Promise.all([t.configure(smtpInput, configKey), t.configure(smtpInput, configKey)]);
    assert.deepEqual(configs.map(row => row.status), [200, 200]); assert.equal(configs[0].body.operation.id, configs[1].body.operation.id);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_smtp_operations").first("n"), 1);
    const edits = await Promise.all([t.configure({ ...smtpInput, smtpRevision: 1 }, crypto.randomUUID()), t.configure({ ...smtpInput, smtpRevision: 1 }, crypto.randomUUID())]);
    assert.deepEqual(edits.map(row => row.status).sort(), [200, 409]);
    const key = crypto.randomUUID(), input = { ...mailInput, smtpRevision: 2 }; gate = t.hold();
    const sending = t.send(input, key); await gate.entered;
    const duplicate = await t.send(input, key); assert.equal(duplicate.status, 202); assert.equal(duplicate.body.outgoing.state, "pending");
    assert.equal((await t.send({ ...input, text: "different" }, key)).status, 409); assert.equal(t.opens.length, 1);
    gate.release(); const sent = await sending; assert.equal(sent.body.outgoing.state, "accepted");
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_outgoing_messages").first("n"), 1);
  } finally { gate?.release(); await t.close(); }
});

test("account/user/source/credential mutations after validation cannot cross the atomic SMTP reservation fence", async () => {
  for (const race of ["account", "deleted", "disabled", "smtp", "secret", "source", "user"]) {
    const t = await normalSendFixture();
    try {
      await t.configure(); const response = await t.send(mailInput, crypto.randomUUID(), { headers: { "idempotency-key": crypto.randomUUID(), "x-test-smtp-race": race } });
      assert.equal(response.body.error?.code, "normal_send_reservation_denied", response.text); assert.equal(t.opens.length, 0);
      assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_outgoing_messages").first("n"), 0);
    } finally { await t.close(); }
  }
});

test("post-DATA storage failure and stale guards remain unknown without another SMTP connection", async () => {
  const t = await normalSendFixture();
  try {
    await t.configure(); const key = crypto.randomUUID();
    const sent = await t.send(mailInput, key, { headers: { "idempotency-key": key, "x-test-smtp-finish-failure": "1" } });
    assert.equal(sent.status, 202, sent.text); assert.equal(sent.body.outgoing.state, "unknown");
    assert.equal((await t.send(mailInput, key)).body.outgoing.state, "pending"); assert.equal(t.messages.length, 1);
    await t.h.db.prepare("UPDATE normal_outgoing_messages SET created_at=created_at-61").run();
    assert.equal((await t.send(mailInput, key)).body.outgoing.state, "unknown");
    await t.h.scheduled(); assert.equal((await t.send(mailInput, key)).body.outgoing.state, "unknown");
    assert.equal(t.opens.length, 1);
  } finally { await t.close(); }
});
