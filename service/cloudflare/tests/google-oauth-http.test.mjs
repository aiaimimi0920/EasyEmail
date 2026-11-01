import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { module as m, config, tokenBody, mockedFetch } from "./google-oauth-module-fixture.mjs";

test("fixed Google endpoints use form encoding, one bounded signal, verified identity and no redirect following", async () => {
  const requests = [];
  const result = await mockedFetch(() => m.exchangeGoogleCode(config, "code+/=&", "synthetic-verifier", "alice@example.test"), async (url, options) => {
    requests.push({ url, options }); assert.equal(options.redirect, "manual");
    if (requests.length === 1) return Response.json(tokenBody());
    return Response.json({ sub: "123456", email: "alice@example.test", email_verified: true });
  });
  assert.equal(result.subject, "123456"); assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(r => r.url), [m.GOOGLE_TOKEN, m.GOOGLE_USERINFO]);
  const form = new URLSearchParams(requests[0].options.body); assert.equal(form.get("code"), "code+/=&"); assert.equal(form.get("client_secret"), config.clientSecret);
  assert.equal(requests[0].options.signal, requests[1].options.signal);
});

test("invalid Google token contracts fail before identity fetch and never retry", async () => {
  for (const change of [{ access_token: "bad\nsecret" }, { refresh_token: undefined }, { token_type: "MAC" }, { expires_in: 0 },
    { expires_in: 9007199254740991 }, { scope: "openid email" }, { scope: undefined }, { refresh_token_expires_in: 9007199254740991 }]) {
    let calls = 0;
    await mockedFetch(() => assert.rejects(m.exchangeGoogleCode(config, "code", "verifier", "alice@example.test"), e => e.code === "google_oauth_token_invalid"),
      async () => { calls++; return Response.json({ ...tokenBody(), ...change }); });
    assert.equal(calls, 1);
  }
});

test("redirect, wrong media type, oversized, malformed and invalid UTF-8 responses are rejected without a second request", async () => {
  for (const response of [() => new Response(null, { status: 302, headers: { location: "https://evil.invalid/token" } }),
    () => new Response(JSON.stringify(tokenBody()), { headers: { "content-type": "text/plain" } }),
    () => new Response("x".repeat(16385), { headers: { "content-type": "application/json" } }),
    () => new Response("{", { headers: { "content-type": "application/json" } }),
    () => new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } })]) {
    let calls = 0;
    await mockedFetch(() => assert.rejects(m.exchangeGoogleCode(config, "code", "verifier", "alice@example.test"), e => e.code === "google_oauth_provider_failed"),
      async () => { calls++; return response(); }); assert.equal(calls, 1);
  }
});

test("a late token response after the shared deadline cannot initiate identity fetch", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); let release, calls = 0;
  await mockedFetch(async () => {
    const pending = m.exchangeGoogleCode(config, "code", "verifier", "alice@example.test");
    const rejected = assert.rejects(pending, e => e.code === "google_oauth_outcome_unknown");
    t.mock.timers.tick(10000); await rejected; release(Response.json(tokenBody()));
    for (let n = 0; n < 20; n++) await Promise.resolve(); assert.equal(calls, 1);
  }, async () => { calls++; return new Promise(resolve => { release = resolve; }); });
  t.mock.timers.reset();
});

test("password endpoint hash bytes stay compatible while Google only permits its fixed mail hosts and transports", async () => {
  const imap = { id: "example", label: "test", hostname: "imap.example.test", port: 993 };
  const smtp = { id: "example", label: "test", hostname: "smtp.example.test", port: 465, recipients: ["*"] };
  const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  assert.equal((await m.imapEndpoint({ IMAP_ENDPOINTS: JSON.stringify([imap]) }, "example")).hash, hash(["imap-tls-v1", imap.hostname, 993]));
  assert.equal((await m.smtpEndpoint({ SMTP_ENDPOINTS: JSON.stringify([{ ...smtp, authentication: "password" }]) }, "example")).hash,
    hash(["smtp-tls-plain-v1", smtp.hostname, 465, smtp.recipients]));
  assert.throws(() => m.imapEndpoints({ IMAP_ENDPOINTS: JSON.stringify([{ ...imap, authentication: "google-oauth2" }]) }));
  assert.throws(() => m.smtpEndpoints({ SMTP_ENDPOINTS: JSON.stringify([{ ...smtp, authentication: "google-oauth2" }]) }));
  assert.throws(() => m.imapEndpoints({ IMAP_ENDPOINTS: JSON.stringify([{ ...imap, hostname: "imap.gmail.com", authentication: "google-oauth2", port: 143, security: "starttls" }]) }));
});
