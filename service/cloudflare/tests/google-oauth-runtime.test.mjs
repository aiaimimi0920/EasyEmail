import assert from "node:assert/strict";
import { test } from "node:test";
import { googleFixture, ACCESS, REFRESH, EMAIL } from "./google-oauth-fixture.mjs";
import { newKey, PASSWORD } from "./runtime-harness.mjs";

test("Google OAuth creates a disabled account without a fake password and installs one encrypted verified grant", async () => {
  const f = await googleFixture();
  try {
    const created = await f.put(); assert.equal(created.status, 201, created.text);
    assert.equal(created.body.account.authentication, "google-oauth2"); assert.equal(created.body.account.credentialConfigured, false);
    assert.equal((await f.put({ ...f.input, emailAddress: "other@example.test", expectedRevision: 1, password: "not-a-token" })).status, 400);
    const key = crypto.randomUUID(), started = await f.start(1, key); assert.equal(started.status, 200, started.text);
    const url = new URL(started.body.authorizationUrl), state = url.searchParams.get("state");
    assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256"); assert.equal(url.searchParams.get("access_type"), "offline");
    assert.equal(url.searchParams.get("redirect_uri"), f.h.appOrigin + "/oauth/google/callback");
    assert.equal((await f.start(1, key)).body.authorizationUrl, url.href); assert.equal(f.calls.length, 0);
    const done = await f.complete(state); assert.equal(done.status, 200, done.text + JSON.stringify(f.calls)); assert.equal(done.body.account.revision, 2);
    assert.equal(done.body.account.enabled, true); assert.equal(done.body.account.username, EMAIL);
    const replay = await f.complete(state); assert.equal(replay.status, 200, replay.text); assert.equal(replay.body.replayed, true);
    assert.equal(f.calls.filter(c => c.url.endsWith("/token")).length, 1);
    const tokenCall = f.calls[0]; assert.equal(tokenCall.body.grant_type, "authorization_code");
    const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tokenCall.body.code_verifier))).toString("base64url");
    assert.equal(url.searchParams.get("code_challenge"), challenge);
    const dump = JSON.stringify(await f.h.db.prepare("SELECT * FROM google_oauth_grants").all());
    const attempts = JSON.stringify(await f.h.db.prepare("SELECT * FROM google_oauth_attempts").all());
    for (const secret of [ACCESS, REFRESH, state, "synthetic-authorization-code", tokenCall.body.code_verifier]) {
      assert.equal((dump + attempts + done.text).includes(secret), false);
    }
    await f.h.restart(); assert.equal((await f.complete(state)).status, 200); assert.equal(f.calls.length, 2);
  } finally { await f.close(); }
});

test("Google OAuth writes require original active session and exact Origin, never API keys or another session", async () => {
  const f = await googleFixture();
  try {
    assert.equal((await f.put()).status, 201);
    const key = await newKey(f.h, f.alice.cookie, { scopes: ["mail-accounts:write"] });
    assert.equal((await f.start(1, crypto.randomUUID(), { cookie: undefined, token: key.token })).status, 403);
    assert.equal((await f.start(1, crypto.randomUUID(), { origin: "https://evil.invalid" })).status, 403);
    const started = await f.start(), state = new URL(started.body.authorizationUrl).searchParams.get("state");
    const other = await f.h.register("oauth-other-session");
    assert.equal((await f.complete(state, undefined, { cookie: other.cookie })).status, 404);
    const login = await f.h.request("/api/v1/auth/login", { method: "POST", body: { username: f.alice.username, password: PASSWORD } });
    assert.equal(login.status, 200); assert.notEqual(login.cookie, f.alice.cookie);
    assert.equal((await f.complete(state, undefined, { cookie: login.cookie })).status, 404);
    await f.h.request("/api/v1/auth/logout", { method: "POST", cookie: f.alice.cookie });
    assert.equal((await f.complete(state)).status, 401); assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("Google callback is a bounded fixed same-origin redirect and never exchanges a code anonymously", async () => {
  const f = await googleFixture();
  try {
    assert.equal((await f.put()).status, 201); const started = await f.start(), state = new URL(started.body.authorizationUrl).searchParams.get("state");
    const callback = `/oauth/google/callback?state=${state}&code=synthetic-code&scope=openid`;
    const response = await fetch(new URL(callback, f.h.baseUrl), { redirect: "manual" });
    assert.equal(response.status, 303); const target = new URL(response.headers.get("location"));
    assert.equal(target.origin, f.h.appOrigin); assert.equal(target.pathname, "/"); assert.equal(target.search, "");
    assert.equal(new URLSearchParams(target.hash.slice(1)).get("ee-google-code"), "synthetic-code");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer"); assert.equal(f.calls.length, 0);
    for (const query of [`state=${state}&state=${state}&code=x`, `state=${state}&code=x&code=y`, "state=bad&code=x", `state=${state}&code=x&iss=https://evil.invalid`]) {
      const bad = await fetch(new URL(`/oauth/google/callback?${query}`, f.h.baseUrl), { redirect: "manual" }); assert.equal(bad.status, 400);
    }
  } finally { await f.close(); }
});

test("explicit denial consumes the bound attempt without token exchange, and status stays private and secret-free", async () => {
  const f = await googleFixture();
  try {
    assert.equal((await f.put()).status, 201); const started = await f.start(), state = new URL(started.body.authorizationUrl).searchParams.get("state");
    const denied = await f.h.request("/api/v1/oauth/google/complete", { method: "POST", cookie: f.alice.cookie, body: { state, denied: true } });
    assert.equal(denied.body.error.code, "google_oauth_denied"); assert.equal(f.calls.length, 0);
    assert.equal((await f.complete(state)).body.error.code, "google_oauth_denied"); assert.equal(f.calls.length, 0);
    assert.equal((await f.h.request(`${f.path}/oauth/google/status`, { cookie: f.alice.cookie })).body.state, "not_authorized");
    const other = await f.h.register("google-status-other"); assert.equal((await f.h.request(`${f.path}/oauth/google/status`, { cookie: other.cookie })).status, 404);
    assert.equal((await f.h.request(`${f.path}/oauth/google/status`, { method: "POST", cookie: f.alice.cookie, body: { expectedRevision: 1 } })).status, 405);
  } finally { await f.close(); }
});
