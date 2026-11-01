import assert from "node:assert/strict";
import { test } from "node:test";
import { googleFixture, EMAIL, ACCESS, REFRESH } from "./google-oauth-fixture.mjs";

const configure = f => f.h.request(`${f.path}/smtp`, { method: "PUT", cookie: f.alice.cookie, headers: { "idempotency-key": crypto.randomUUID() },
  body: { expectedRevision: 2, smtpRevision: 0, endpointId: "google", username: EMAIL, enabled: true } });
const check = f => f.h.request(`${f.path}/test`, { method: "POST", cookie: f.alice.cookie, body: { expectedRevision: 2 } });
const send = (f, key = crypto.randomUUID()) => f.h.request(`${f.path}/send`, { method: "POST", cookie: f.alice.cookie,
  headers: { "idempotency-key": key }, body: { expectedRevision: 2, smtpRevision: 1, to: "receiver@example.test", subject: "OAuth test", text: "Synthetic mail" } });
const entered = gate => Promise.race([gate.entered, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error("Refresh gate not entered")), 10000); timer.unref(); })]);

test("Google grant drives real IMAP test, inbox sync and SMTP API without exposing or importing tokens", async () => {
  const f = await googleFixture(false, true);
  try {
    await f.authorize(); const configured = await configure(f); assert.equal(configured.status, 200, configured.text);
    assert.equal(configured.body.smtp.credentialConfigured, true); assert.equal(configured.body.smtp.current, true);
    const checked = await check(f); assert.equal(checked.status, 200, checked.text);
    const sync = await f.h.request(`${f.path}/sync`, { method: "POST", cookie: f.alice.cookie, headers: { "idempotency-key": crypto.randomUUID() }, body: { expectedRevision: 2 } });
    assert.equal(sync.status, 200, sync.text); assert.equal(sync.body.request.state, "committed");
    const key = crypto.randomUUID(), sent = await send(f, key); assert.equal(sent.status, 201, sent.text);
    assert.equal(sent.body.outgoing.state, "accepted"); assert.equal(sent.body.outgoing.delivery, "unconfirmed");
    assert.equal((await send(f, key)).status, 200); assert.equal(f.opens.length, 3);
    for (const { peer } of f.sessions.values()) {
      assert.equal(peer.credentials.length, 1); assert.deepEqual(peer.credentials[0], { method: "XOAUTH2", value: `user=${EMAIL}\x01auth=Bearer ${ACCESS}\x01\x01` });
    }
    assert.equal((checked.text + configured.text + sync.text + sent.text).includes(ACCESS), false);
  } finally { await f.close(); }
});

test("one refresh owner spans IMAP and SMTP and no SMTP reservation is made by a competing refresh", async () => {
  const f = await googleFixture(false, true); let gate, pending;
  try {
    f.mode("short"); await f.authorize(); assert.equal((await configure(f)).status, 200); f.mode("normal");
    gate = f.hold(); pending = check(f); await entered(gate);
    const key = crypto.randomUUID(), other = await send(f, key); assert.equal(other.status, 409, other.text);
    assert.equal(other.body.error.code, "google_oauth_refresh_busy"); assert.equal(f.opens.length, 0);
    assert.equal(await f.h.db.prepare("SELECT COUNT(*) n FROM normal_outgoing_messages").first("n"), 0);
    gate.release(); const checked = await pending; assert.equal(checked.status, 200, checked.text);
    assert.equal((await send(f, key)).status, 201); assert.equal(f.opens.length, 2);
    const refreshes = f.calls.filter(c => c.body.grant_type === "refresh_token"); assert.equal(refreshes.length, 1);
    assert.equal(refreshes[0].body.refresh_token, REFRESH);
  } finally { gate?.release(); await pending; await f.close(); }
});

test("rotated refresh tokens are used next time and omitted refresh tokens retain the current encrypted token", async () => {
  const f = await googleFixture(false, true);
  try {
    f.mode("short"); await f.authorize(); f.mode("rotate"); assert.equal((await check(f)).status, 200);
    f.mode("no-refresh"); assert.equal((await check(f)).status, 200);
    f.mode("normal"); assert.equal((await check(f)).status, 200);
    assert.deepEqual(f.calls.filter(c => c.body.grant_type === "refresh_token").map(c => c.body.refresh_token), [REFRESH, REFRESH + "-rotated", REFRESH + "-rotated"]);
    assert.equal((await f.h.db.prepare("SELECT version FROM google_oauth_grants WHERE state='active'").first()).version, 4);
  } finally { await f.close(); }
});

test("local disconnect fences late refresh, clears both credentials and replays without remote revocation or resend", async () => {
  const f = await googleFixture(false, true); let gate, pending;
  try {
    f.mode("short"); await f.authorize(); assert.equal((await configure(f)).status, 200); f.mode("normal");
    gate = f.hold(); pending = check(f); await entered(gate);
    const key = crypto.randomUUID(), disconnect = () => f.h.request(`${f.path}/oauth/google/disconnect`, { method: "POST", cookie: f.alice.cookie,
      headers: { "idempotency-key": key }, body: { expectedRevision: 2 } });
    const disconnected = await disconnect(); assert.equal(disconnected.status, 200, disconnected.text);
    assert.equal(disconnected.body.remoteRevocation, "not_requested"); assert.equal(disconnected.body.account.revision, 3);
    gate.release(); assert.equal((await pending).status, 409); assert.equal(f.opens.length, 0);
    const row = await f.h.db.prepare("SELECT * FROM google_oauth_grants").first(); assert.equal(row.state, "disconnected"); assert.equal(row.secret_cipher, null);
    const smtp = await f.h.db.prepare("SELECT enabled,credential_cipher FROM normal_smtp_configs").first(); assert.equal(smtp.enabled, 0); assert.equal(smtp.credential_cipher, null);
    const count = f.calls.length; assert.equal((await disconnect()).body.replayed, true); assert.equal(f.calls.length, count);
  } finally { gate?.release(); await pending; await f.close(); }
});

test("invalid_grant refresh clears unusable secrets and is not retried on the next mail operation", async () => {
  const f = await googleFixture(false, true);
  try {
    f.mode("short"); await f.authorize(); f.mode("invalid-grant"); const result = await check(f);
    assert.equal(result.status, 502, result.text); const count = f.calls.length;
    assert.equal((await check(f)).body.error.code, "google_oauth_reauthorization_required"); assert.equal(f.calls.length, count); assert.equal(f.opens.length, 0);
    const grant = await f.h.db.prepare("SELECT state,secret_cipher FROM google_oauth_grants").first(); assert.equal(grant.state, "reauthorize"); assert.equal(grant.secret_cipher, null);
  } finally { await f.close(); }
});

test("Google SMTP DATA uncertainty preserves the original send guard and never refreshes or resends on replay", async () => {
  const f = await googleFixture(false, true);
  try {
    await f.authorize(); assert.equal((await configure(f)).status, 200); f.mailMode("smtp", { final: "drop" });
    const key = crypto.randomUUID(), result = await send(f, key); assert.equal(result.status, 202, result.text);
    assert.equal(result.body.outgoing.state, "unknown"); const count = f.calls.length;
    assert.equal((await send(f, key)).body.outgoing.state, "unknown"); assert.equal(f.opens.length, 1); assert.equal(f.calls.length, count);
  } finally { await f.close(); }
});
