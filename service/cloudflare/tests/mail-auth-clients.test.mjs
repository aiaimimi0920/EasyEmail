import assert from "node:assert/strict";
import { test } from "node:test";
import { mailAuthPeer } from "./mail-auth-peer-fixture.mjs";
import { authentication, endpoint, invoke, password, socketHook, token, username } from "./mail-auth-module-fixture.mjs";

const bearer = `user=${username}\x01auth=Bearer ${token}\x01\x01`;
function peer(protocol, security, options) { const p = mailAuthPeer(protocol, security, options); globalThis[socketHook] = p.connect; return p; }
async function failure(protocol, pending, code) {
  if (protocol === "imap") await assert.rejects(pending, error => error.code === code && !error.message.includes("synthetic-private-error") && !error.message.includes(token));
  else assert.deepEqual(await pending, { state: "rejected", error: code });
}
for (const protocol of ["imap", "smtp"]) for (const security of ["tls", "starttls"]) {
  test(`${protocol} ${security} uses only explicit XOAUTH2 and keeps TLS/capability ordering`, async () => {
    const p = peer(protocol, security), result = await invoke(protocol, security);
    assert.equal(protocol === "imap" ? result.authenticated : result.state, protocol === "imap" ? true : "accepted");
    assert.deepEqual(p.credentials, [{ method: "XOAUTH2", value: bearer }]);
    assert.equal(p.upgrades, Number(security === "starttls"));
    assert.deepEqual(p.calls[0], { address: { hostname: endpoint(protocol, security).hostname, port: endpoint(protocol, security).port },
      options: { secureTransport: security === "starttls" ? "starttls" : "on", allowHalfOpen: false } });
    assert.equal(p.sockets.at(-1).closes, 1); assert.equal(p.calls.filter(c => c.address).length, 1);
    assert.ok(p.calls.filter(c => c.text?.includes("AUTHENTICATE") || c.text?.startsWith("AUTH ")).every(c => c.stage === "tls" && c.text.includes("XOAUTH2")));
    assert.equal(p.sockets.some(s => s.readable.locked || s.writable.locked), false);
  });
  test(`${protocol} ${security} legacy string remains byte-compatible AUTH PLAIN`, async () => {
    const p = peer(protocol, security), result = await invoke(protocol, security, password);
    assert.equal(protocol === "imap" ? result.authenticated : result.state, protocol === "imap" ? true : "accepted");
    assert.deepEqual(p.credentials, [{ method: "PLAIN", value: `\0${username}\0${password}` }]);
  });
  test(`${protocol} ${security} does not downgrade when XOAUTH2 is absent after TLS`, async () => {
    const p = peer(protocol, security, { after: "AUTH=PLAIN" });
    await failure(protocol, invoke(protocol, security), `${protocol}_auth_method_unavailable`);
    assert.deepEqual(p.credentials, []); assert.equal(p.calls.some(c => c.text?.includes("AUTHENTICATE") || c.text?.startsWith("AUTH ")), false);
  });
}
for (const saslIr of [true, false]) test(`IMAP ${saslIr ? "with" : "without"} SASL-IR sends one token and still uses EXAMINE/BODY.PEEK`, async () => {
  const p = peer("imap", "starttls", { saslIr }), result = await invoke("imap", "starttls", authentication, true);
  assert.equal(result.items.length, 2); assert.deepEqual(result.cursor, { uidValidity: "42", afterUid: 7 });
  assert.deepEqual(p.credentials, [{ method: "XOAUTH2", value: bearer }]);
  const command = p.calls.find(c => c.text?.includes("AUTHENTICATE")); assert.equal(command.text.trimEnd().split(" ").length, saslIr ? 4 : 3);
  assert.equal(p.calls.some(c => /\b(?:SELECT|STORE|MOVE|EXPUNGE)\b/.test(c.text ?? "")), false);
  assert.equal(p.calls.filter(c => c.text?.includes("BODY.PEEK[]")).length, 2);
});
for (const protocol of ["imap", "smtp"]) for (const mode of ["error", "error-ok", "double-error", "reject"]) {
  test(`${protocol} XOAUTH2 ${mode} fails closed without replay, fallback or envelope`, async () => {
    const p = peer(protocol, "starttls", { mode }); await failure(protocol, invoke(protocol, "starttls"), `${protocol}_auth_failed`);
    assert.deepEqual(p.credentials, [{ method: "XOAUTH2", value: bearer }]);
    const writes = p.calls.filter(c => c.text); assert.equal(writes.filter(c => c.text === "\r\n").length, mode === "reject" ? 0 : 1);
    assert.equal(writes.some(c => /\b(?:EXAMINE|MAIL|RCPT|DATA)\b/.test(c.text)), false);
    assert.equal(writes.some(c => /AUTH(?:ENTICATE)? PLAIN/.test(c.text)), false); assert.equal(p.calls.filter(c => c.address).length, 1);
  });
}
for (const mode of ["error", "error-ok", "double-error"]) test(`IMAP non-SASL-IR ${mode} acknowledges once after sending one token`, async () => {
  const p = peer("imap", "starttls", { saslIr: false, mode }); await failure("imap", invoke("imap", "starttls"), "imap_auth_failed");
  assert.deepEqual(p.credentials, [{ method: "XOAUTH2", value: bearer }]);
  assert.equal(p.calls.filter(c => c.text === "\r\n").length, 1); assert.equal(p.calls.some(c => c.text?.includes("EXAMINE")), false);
});
test("IMAP nonempty challenge before sending a token is not an invitation to disclose it", async () => {
  const p = peer("imap", "tls", { saslIr: false, earlyChallenge: true });
  await failure("imap", invoke("imap"), "imap_auth_failed"); assert.deepEqual(p.credentials, []);
  assert.equal(p.calls.some(c => c.text === "\r\n"), false);
});
test("IMAP unsolicited success without SASL-IR cannot open INBOX", async () => {
  const p = peer("imap", "tls", { saslIr: false, unsolicited: true });
  await failure("imap", invoke("imap"), "imap_protocol_invalid"); assert.deepEqual(p.credentials, []);
  assert.equal(p.calls.some(c => c.text?.includes("EXAMINE")), false);
});
for (const protocol of ["imap", "smtp"]) test(`${protocol} SASL mechanism capabilities are case-insensitive`, async () => {
  const p = peer(protocol, "tls", { after: "auth=plain auth=xoauth2 sasl-ir" });
  const result = await invoke(protocol); assert.equal(protocol === "imap" ? result.authenticated : result.state, protocol === "imap" ? true : "accepted");
  assert.deepEqual(p.credentials, [{ method: "XOAUTH2", value: bearer }]);
});
test("maximum bounded bearer token is serialized as UTF-8 without whitespace or truncation", async () => {
  const p = peer("imap", "tls"), login = "用户@example.test", accessToken = "a".repeat(4096);
  assert.equal((await invoke("imap", "tls", { method: "xoauth2", accessToken }, false, login)).authenticated, true);
  assert.deepEqual(p.credentials, [{ method: "XOAUTH2", value: `user=${login}\x01auth=Bearer ${accessToken}\x01\x01` }]);
});
test("SMTP legacy PLAIN continuation still resends the same PLAIN response once", async () => {
  const p = peer("smtp", "tls", { mode: "plain-challenge" }); assert.equal((await invoke("smtp", "tls", password)).state, "accepted");
  assert.deepEqual(p.credentials, [{ method: "PLAIN", value: `\0${username}\0${password}` }]);
  const encoded = Buffer.from(`\0${username}\0${password}`).toString("base64") + "\r\n";
  const writes = p.calls.filter(c => c.text?.startsWith("AUTH PLAIN ") || c.text === encoded);
  assert.equal(writes.length, 2); assert.equal(writes[0].text.slice(11), writes[1].text);
});
for (const [final, state] of [["drop", "unknown"], ["reject", "rejected"], [undefined, "accepted"]]) {
  test(`SMTP XOAUTH2 preserves ${state} DATA semantics`, async () => {
    const p = peer("smtp", "starttls", { final }); assert.equal((await invoke("smtp", "starttls")).state, state);
    assert.equal(p.credentials.length, 1); assert.equal(p.calls.filter(c => c.text === "DATA\r\n").length, 1);
  });
}
