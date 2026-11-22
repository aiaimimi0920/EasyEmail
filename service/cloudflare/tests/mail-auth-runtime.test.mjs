import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mailAuthFixture } from "./mail-auth-runtime-fixture.mjs";

let f; before(async () => { f = await mailAuthFixture(); }); after(async () => { await f?.close(); });
const token = "ya29.Synthetic-_~+/accessToken==", username = "alice@example.test";
const invoke = (protocol, security = "tls", read = false) => f.h.request("/__test/mail-auth", { method: "POST", body: { protocol, security, read } });
for (const protocol of ["imap", "smtp"]) for (const security of ["tls", "starttls"]) test(`workerd ${protocol} ${security} runs native clients with a single synthetic XOAUTH2 credential`, async () => {
  f.mode(protocol, {}); const response = await invoke(protocol, security); assert.equal(response.status, 200, response.text);
  assert.equal(protocol === "imap" ? response.body.authenticated : response.body.state, protocol === "imap" ? true : "accepted");
  const session = [...f.sessions.values()].at(-1); assert.equal(session.upgraded, security === "starttls");
  assert.deepEqual(session.peer.credentials, [{ method: "XOAUTH2", value: `user=${username}\x01auth=Bearer ${token}\x01\x01` }]);
  assert.equal(response.text.includes(token), false);
});
test("workerd non-SASL-IR IMAP continues into byte-literal UID reads without mutations", async () => {
  f.mode("imap", { saslIr: false }); const response = await invoke("imap", "starttls", true);
  assert.equal(response.status, 200, response.text); assert.equal(response.body.items, 2); assert.equal(response.body.complete, true);
  assert.deepEqual(response.body.cursor, { uidValidity: "42", afterUid: 7 });
});
for (const protocol of ["imap", "smtp"]) test(`workerd ${protocol} error challenge never installs success or advances the envelope`, async () => {
  f.mode(protocol, { mode: "error-ok" }); const response = await invoke(protocol, "starttls");
  assert.equal(response.status, protocol === "imap" ? 403 : 200, response.text);
  assert.deepEqual(response.body, protocol === "imap" ? { error: "imap_auth_failed" } : { state: "rejected", error: "smtp_auth_failed" });
  const session = [...f.sessions.values()].at(-1); assert.equal(session.peer.credentials.length, 1);
  assert.equal(session.peer.calls.filter(c => c.text === "\r\n").length, 1);
  assert.equal(session.peer.calls.some(c => /\b(?:EXAMINE|MAIL|RCPT|DATA)\b/.test(c.text)), false);
  assert.doesNotMatch(response.text, /synthetic-private-error|accessToken|ya29/);
});
test("public account/SMTP APIs still refuse token objects and OAuth fields rather than importing unowned tokens", async () => {
  const alice = await f.h.register("mail-auth-boundary"), id = crypto.randomUUID(), accountPath = `/api/v1/normal-accounts/${id}`;
  const input = { expectedRevision: 0, emailAddress: username, displayName: "Synthetic", endpointId: "example", username,
    enabled: true, password: { method: "xoauth2", accessToken: token } };
  const write = (path, body) => f.h.request(path, { method: "PUT", cookie: alice.cookie, body, headers: { "idempotency-key": crypto.randomUUID() } });
  const before = f.opens.length;
  assert.equal((await write(accountPath, input)).body.error.code, "invalid_normal_account_request");
  assert.equal((await write(accountPath, { ...input, password: "synthetic-password", oauth: true })).body.error.code, "invalid_normal_account_request");
  assert.equal((await write(accountPath, { ...input, password: "synthetic-password" })).status, 201);
  const smtp = await write(accountPath + "/smtp", { expectedRevision: 1, smtpRevision: 0, endpointId: "example", username, enabled: true, password: input.password });
  assert.equal(smtp.body.error.code, "invalid_smtp_request");
  assert.equal((await f.h.request("/oauth/callback")).status, 404); assert.equal(f.opens.length, before);
  const rows = await f.h.db.prepare("SELECT credential_cipher FROM normal_accounts WHERE id=?").bind(id).first();
  assert.equal(rows.credential_cipher.includes(token), false);
});
