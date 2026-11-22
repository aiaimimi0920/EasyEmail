import assert from "node:assert/strict";
import { test } from "node:test";
import { googleFixture } from "./google-oauth-fixture.mjs";

const entered = gate => Promise.race([gate.entered, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error("OAuth gate not entered")), 10000); timer.unref(); })]);
test("one state has one exchange owner even when callback completion is concurrent", async () => {
  const f = await googleFixture(); let gate, pending;
  try {
    assert.equal((await f.put()).status, 201); const start = await f.start(), state = new URL(start.body.authorizationUrl).searchParams.get("state");
    gate = f.hold(); pending = f.complete(state); await entered(gate);
    const second = await f.complete(state); assert.equal(second.status, 409); assert.equal(second.body.error.code, "google_oauth_in_progress");
    assert.equal(f.calls.length, 1); gate.release(); assert.equal((await pending).status, 200);
    assert.equal((await f.complete(state)).body.replayed, true); assert.equal(f.calls.length, 2);
  } finally { gate?.release(); await pending; await f.close(); }
});

for (const mutation of ["account", "logout", "supersede", "disconnect", "expiry"]) test(`late code exchange cannot install after ${mutation}`, async () => {
  const f = await googleFixture(); let gate, pending;
  try {
    assert.equal((await f.put()).status, 201); const start = await f.start(), state = new URL(start.body.authorizationUrl).searchParams.get("state");
    gate = f.hold(); pending = f.complete(state); await entered(gate);
    if (mutation === "account") assert.equal((await f.put({ ...f.input, expectedRevision: 1, displayName: "Changed while authorizing" })).status, 200);
    if (mutation === "logout") assert.equal((await f.h.request("/api/v1/auth/logout", { method: "POST", cookie: f.alice.cookie })).status, 200);
    if (mutation === "supersede") assert.equal((await f.start()).status, 200);
    if (mutation === "expiry") {
      await f.h.db.prepare("UPDATE google_oauth_attempts SET exchange_until=unixepoch()-1 WHERE state='exchanging'").run();
      await f.h.scheduled();
      const expired = await f.h.db.prepare("SELECT state,secret_cipher FROM google_oauth_attempts").first();
      assert.equal(expired.state, "failed"); assert.equal(expired.secret_cipher, null);
    }
    if (mutation === "disconnect") assert.equal((await f.h.request(`${f.path}/oauth/google/disconnect`, { method: "POST", cookie: f.alice.cookie,
      headers: { "idempotency-key": crypto.randomUUID() }, body: { expectedRevision: 1 } })).status, 200);
    gate.release(); const result = await pending; assert.equal(result.status, 409, result.text);
    assert.equal(await f.h.db.prepare("SELECT COUNT(*) n FROM google_oauth_grants").first("n"), 0);
    const row = await f.h.db.prepare("SELECT credential_cipher,enabled FROM normal_accounts WHERE id=?").bind(f.id).first();
    assert.equal(row.credential_cipher, null); assert.equal(row.enabled, 0);
    if (mutation === "expiry") { const count = f.calls.length; assert.equal((await f.complete(state)).status, 409); assert.equal(f.calls.length, count); }
  } finally { gate?.release(); await pending; await f.close(); }
});

for (const mode of ["wrong-email", "unverified", "missing-scope", "invalid-grant", "redirect"]) test(`Google ${mode} fails closed and never re-exchanges the consumed code`, async () => {
  const f = await googleFixture();
  try {
    assert.equal((await f.put()).status, 201); const start = await f.start(), state = new URL(start.body.authorizationUrl).searchParams.get("state");
    f.mode(mode); const result = await f.complete(state); assert.ok(result.status >= 400, result.text);
    const count = f.calls.length; assert.ok((await f.complete(state)).status >= 400); assert.equal(f.calls.length, count);
    assert.equal(await f.h.db.prepare("SELECT COUNT(*) n FROM google_oauth_grants").first("n"), 0);
    assert.equal(result.text.includes("secret-provider-description"), false);
    const attempt = await f.h.db.prepare("SELECT state,secret_cipher FROM google_oauth_attempts").first();
    assert.equal(attempt.state, "failed"); assert.equal(attempt.secret_cipher, null);
  } finally { await f.close(); }
});
