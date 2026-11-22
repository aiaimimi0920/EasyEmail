import assert from "node:assert/strict";
import { test } from "node:test";
import { runtime, endpoints, message, socketHook } from "./starttls-module-fixture.mjs";
import { starttlsPeer } from "./starttls-peer-fixture.mjs";

function peer(protocol, mode) { const p = starttlsPeer(protocol, mode); globalThis[socketHook] = p.connect; return p; }
function run(protocol, read = false) {
  return protocol === "imap" ? runtime[read ? "readImapMessages" : "testImapConnection"](endpoints.imap, "Alice", "synthetic-secret")
    : runtime.sendSmtp(endpoints.smtp, "Alice", "synthetic-secret", message);
}
for (const protocol of ["imap", "smtp"]) test(`${protocol} STARTTLS replaces streams once and re-discovers capabilities before credentials`, async () => {
  const p = peer(protocol), result = await run(protocol);
  if (protocol === "imap") assert.equal(result.authenticated, true); else assert.equal(result.state, "accepted");
  assert.deepEqual(p.calls[0], { address: { hostname: endpoints[protocol].hostname, port: endpoints[protocol].port }, options: { secureTransport: "starttls", allowHalfOpen: false } });
  assert.equal(p.upgrades, 1); assert.equal(p.sockets.length, 2); assert.equal(p.sockets[1].closes, 1);
  const writes = p.calls.filter(c => c.text);
  assert.deepEqual(writes.filter(c => c.stage === "plain").map(c => c.text.trimEnd().replace(/^ee\d+ /, "")), protocol === "imap" ? ["CAPABILITY", "STARTTLS"] : ["EHLO easyemail.invalid", "STARTTLS"]);
  assert.match(writes.find(c => c.stage === "tls").text, protocol === "imap" ? /CAPABILITY/ : /^EHLO /);
  assert.equal(p.sockets[0].readable.locked || p.sockets[1].readable.locked, false);
});
test("IMAP UID read continues on the upgraded socket with unchanged literal and cursor semantics", async () => {
  const p = peer("imap"), result = await run("imap", true);
  assert.equal(result.items.length, 2); assert.match(new TextDecoder().decode(result.items[0].raw), /验证码 742951/);
  assert.deepEqual(result.cursor, { uidValidity: "42", afterUid: 7 });
  assert.equal(p.calls.filter(c => c.text?.includes("BODY.PEEK[]")).every(c => c.stage === "tls"), true);
});
for (const protocol of ["imap", "smtp"]) for (const mode of ["no-starttls", "reject", "upgrade-throw", "opened-reject", "no-auth", "buffered"]) {
  test(`${protocol} ${mode} fails closed without credentials, fallback or reconnect`, async () => {
    const p = peer(protocol, mode);
    if (protocol === "imap") await assert.rejects(run(protocol)); else assert.equal((await run(protocol)).state, "rejected");
    assert.equal(p.calls.filter(c => c.address).length, 1);
    assert.equal(p.calls.some(c => c.text?.includes("AUTHENTICATE") || c.text?.startsWith("AUTH PLAIN ")), false);
    assert.equal(p.calls.some(c => /^(?:MAIL|RCPT|DATA)\b/.test(c.text ?? "")), false);
    assert.equal(p.sockets.at(-1).closes, 1);
    if (mode === "buffered") assert.equal(p.upgrades, 0, "buffered plaintext is never promoted into the TLS parser");
  });
}
for (const [mode, state] of [["drop-final", "unknown"], ["invalid-final", "unknown"], ["final-reject", "rejected"], ["close-reject", "accepted"]]) {
  test(`SMTP STARTTLS ${mode} preserves final-DATA outcome ${state}`, async () => {
    const p = peer("smtp", mode); assert.equal((await run("smtp")).state, state); assert.equal(p.upgrades, 1);
  });
}
for (const protocol of ["imap", "smtp"]) test(`${protocol} handshake deadline owns the secure socket and rejects late credential writes`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const p = peer(protocol, "opened-stall"), pending = run(protocol);
  const outcome = pending.then(value => ({ value }), error => ({ error }));
  for (let n = 0; n < 200 && p.upgrades === 0; n++) await Promise.resolve();
  assert.equal(p.upgrades, 1); t.mock.timers.tick(15000);
  const result = await outcome;
  assert.equal(protocol === "imap" ? result.error?.code : result.value.error, `${protocol}_timeout`);
  assert.equal(p.sockets[1].closes, 1); const count = p.calls.length; p.releaseOpened();
  for (let n = 0; n < 50; n++) await Promise.resolve();
  assert.equal(p.calls.length, count, "late opened cannot resume the exchange after ownership ended");
});
