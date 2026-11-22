import assert from "node:assert/strict";
import { test } from "node:test";
import { starttlsFixture, imapStarttls, smtpStarttls, accountInput, configInput, sendInput } from "./starttls-runtime-fixture.mjs";

test("STARTTLS API authenticates read-only, caches real literal bytes and preserves receive/send guards across restart", async () => {
  const t = await starttlsFixture();
  try {
    const checked = await t.test(); assert.equal(checked.status, 200, checked.text); assert.equal(checked.body.test.readOnly, true);
    const key = crypto.randomUUID(), received = await t.receive(key); assert.equal(received.status, 200, received.text); assert.equal(received.body.request.result.stored, 2);
    const row = await t.h.db.prepare("SELECT raw_key FROM normal_inbox_messages ORDER BY uid LIMIT 1").first();
    const bytes = new Uint8Array(await (await (await t.h.bucket("INBOX")).get(row.raw_key)).arrayBuffer());
    assert.match(new TextDecoder().decode(bytes), /验证码 742951/); assert.equal((await t.configure()).status, 200);
    const sendKey = crypto.randomUUID(), sent = await t.send(sendInput, sendKey);
    assert.equal(sent.status, 201, sent.text); assert.equal(sent.body.outgoing.state, "accepted"); assert.equal(sent.body.outgoing.delivery, "unconfirmed");
    const count = t.opens.length; await t.h.restart();
    assert.equal((await t.receive(key)).body.request.result.stored, 2); assert.equal((await t.send(sendInput, sendKey)).body.outgoing.id, sent.body.outgoing.id);
    assert.equal(t.opens.length, count); assert.equal(t.events.filter(e => e.action === "/upgrade").length, count);
    assert.equal(t.events.filter(e => e.action === "/close" && e.stage === "tls").length, count);
    const metadata = await t.h.request("/api/v1/normal-accounts/smtp-endpoints", { cookie: t.alice.cookie });
    assert.deepEqual(metadata.body.items[0], { id: "example", label: "SMTP 升级", hostname: smtpStarttls.hostname, port: 587, security: "starttls" });
    assert.equal(metadata.text.includes("recipients"), false);
  } finally { await t.close(); }
});
test("TLS mode changes fence reads and sends before sockets and require explicit credential rebinding", async () => {
  const t = await starttlsFixture();
  try {
    await t.configure();
    await t.h.restart({ IMAP_ENDPOINTS: JSON.stringify([{ ...imapStarttls, port: 993, security: "tls" }]),
      SMTP_ENDPOINTS: JSON.stringify([{ ...smtpStarttls, port: 465, security: "tls" }]) });
    assert.equal((await t.test()).body.error.code, "imap_endpoint_changed");
    assert.equal((await t.receive()).body.request.errorCode, "imap_endpoint_changed");
    assert.equal((await t.send()).body.error.code, "smtp_endpoint_changed"); assert.equal(t.opens.length, 0);
    assert.equal((await t.configure({ ...configInput, smtpRevision: 1, password: undefined })).body.error.code, "smtp_credential_required");
    assert.equal((await t.save({ ...accountInput, expectedRevision: 1, password: undefined })).body.error.code, "normal_credential_required");
    const saved = await t.save({ ...accountInput, expectedRevision: 1 }); assert.equal(saved.status, 200, saved.text);
    assert.equal((await t.configure({ ...configInput, expectedRevision: 2, smtpRevision: 1 })).status, 200);
    assert.equal(t.opens.length, 0);
  } finally { await t.close(); }
});
for (const [mode, state] of [["no-starttls", "rejected"], ["drop-final", "unknown"]]) test(`STARTTLS ${mode} receipt survives restart and cannot reconnect on the original key`, async () => {
  const t = await starttlsFixture();
  try {
    await t.configure(); t.mode("smtp", mode); const key = crypto.randomUUID(), sent = await t.send(sendInput, key);
    assert.equal(sent.body.outgoing.state, state, sent.text); const opens = t.opens.length;
    await t.h.restart(); assert.equal((await t.send(sendInput, key)).body.outgoing.id, sent.body.outgoing.id); assert.equal(t.opens.length, opens);
    assert.equal(t.events.some(e => e.stage === "plain" && /^(?:AUTH|MAIL|RCPT|DATA)\b/.test(e.text ?? "")), false);
  } finally { await t.close(); }
});
