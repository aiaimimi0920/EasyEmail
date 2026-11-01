import assert from "node:assert/strict";
import { test } from "node:test";
import { googleFixture, ACCESS, REFRESH } from "./google-oauth-fixture.mjs";
import { newKey, PASSWORD } from "./runtime-harness.mjs";

test("Agent Google authorization installs an isolated encrypted grant and replays once across restart", async () => {
  const f = await googleFixture(false, false, { scope: "agent" });
  try {
    assert.equal((await f.put()).status, 201);
    const created = await f.h.request(f.path, { cookie: f.alice.cookie });
    assert.equal(created.body.account.authentication, "google-oauth2"); assert.equal(created.body.account.enabled, false);
    const key = crypto.randomUUID(), started = await f.start(1, key); assert.equal(started.status, 200, started.text);
    assert.equal((await f.start(1, key)).body.authorizationUrl, started.body.authorizationUrl);
    const state = new URL(started.body.authorizationUrl).searchParams.get("state");
    const callback = await fetch(new URL(`/oauth/google/callback?state=${state}&code=synthetic-code`, f.h.baseUrl), { redirect: "manual" });
    assert.equal(callback.status, 303); assert.equal(f.calls.length, 0);
    const result = await f.complete(state); assert.equal(result.status, 200, result.text);
    assert.equal(result.body.account.scope, "agent"); assert.equal(result.body.account.authentication, "google-oauth2");
    assert.equal(result.body.account.revision, 2); assert.equal(result.body.account.credentialConfigured, true);
    assert.equal((await f.complete(state)).body.replayed, true); await f.h.restart();
    assert.equal((await f.complete(state)).body.replayed, true); assert.equal(f.calls.length, 2);
    assert.equal(await f.h.db.prepare("SELECT COUNT(*) n FROM google_oauth_grants").first("n"), 0);
    const dump = JSON.stringify((await f.h.db.prepare("SELECT * FROM agent_google_oauth_grants").all()).results);
    for (const secret of [ACCESS, REFRESH, state, "synthetic-code"]) assert.equal((dump + result.text).includes(secret), false);
    const automatic = await f.h.request(`${f.path}/auto-inbox`, { cookie: f.alice.cookie }); assert.equal(automatic.body.config.enabled, false);
    const smtp = await f.h.request(`${f.path}/smtp`, { cookie: f.alice.cookie }); assert.equal(smtp.body.smtp.enabled, false);
  } finally { await f.close(); }
});

test("Agent Google writes require exact Origin and original live session, never delegated API keys", async () => {
  const f = await googleFixture(false, false, { scope: "agent" });
  try {
    assert.equal((await f.put()).status, 201);
    const key = await newKey(f.h, f.alice.cookie, { scopes: ["agent-accounts:read", "agent-accounts:write"] });
    assert.equal((await f.start(1, crypto.randomUUID(), { cookie: undefined, token: key.token })).status, 403);
    assert.equal((await f.start(1, crypto.randomUUID(), { origin: "https://evil.invalid" })).status, 403);
    const started = await f.start(), state = new URL(started.body.authorizationUrl).searchParams.get("state");
    const other = await f.h.register("agent-oauth-other");
    assert.equal((await f.complete(state, undefined, { cookie: other.cookie })).status, 404);
    const login = await f.h.request("/api/v1/auth/login", { method: "POST", body: { username: f.alice.username, password: PASSWORD } });
    assert.equal((await f.complete(state, undefined, { cookie: login.cookie })).status, 404);
    await f.h.request("/api/v1/auth/logout", { method: "POST", cookie: f.alice.cookie });
    assert.equal((await f.complete(state)).status, 401); assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("same UUID normal and Agent authorizations never share state, grants, references or disconnect receipts", async () => {
  const f = await googleFixture(false, false, { scope: "agent" });
  try {
    await f.authorize(); const normal = `/api/v1/normal-accounts/${f.id}`;
    const request = (path, body, key = crypto.randomUUID()) => f.h.request(path, { method: path === normal ? "PUT" : "POST", cookie: f.alice.cookie, headers: { "idempotency-key": key }, body });
    assert.equal((await request(normal, f.input)).status, 201);
    const key = crypto.randomUUID(), started = await request(`${normal}/oauth/google/start`, { expectedRevision: 1 }, key);
    assert.equal(started.status, 200, started.text);
    const done = await f.complete(new URL(started.body.authorizationUrl).searchParams.get("state")); assert.equal(done.status, 200, done.text);
    assert.equal(done.body.account.scope, undefined);
    const agent = await f.h.db.prepare("SELECT * FROM agent_google_oauth_grants").first();
    const other = await f.h.db.prepare("SELECT * FROM google_oauth_grants").first(); assert.notEqual(agent.id, other.id);
    const disconnect = await request(`${f.path}/oauth/google/disconnect`, { expectedRevision: 2 }, key); assert.equal(disconnect.status, 200, disconnect.text);
    assert.equal(disconnect.body.account.scope, "agent"); assert.equal(disconnect.body.remoteRevocation, "not_requested");
    assert.equal((await f.h.request(`${normal}/oauth/google/status`, { cookie: f.alice.cookie })).body.state, "active");
    assert.equal((await f.h.request(`${f.path}/oauth/google/status`, { cookie: f.alice.cookie })).body.state, "not_authorized");
    assert.equal((await request(`${f.path}/oauth/google/disconnect`, { expectedRevision: 2 }, key)).body.replayed, true);
  } finally { await f.close(); }
});
