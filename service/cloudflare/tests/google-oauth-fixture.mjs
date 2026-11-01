import assert from "node:assert/strict";
import { createHarness } from "./runtime-harness.mjs";
import { fileURLToPath } from "node:url";
import { mailAuthPeer } from "./mail-auth-peer-fixture.mjs";

export const EMAIL = "alice@example.test", ACCESS = "ya29.Synthetic-Google-access", REFRESH = "1//Synthetic-Google-refresh";
export const googleImap = { id: "google", label: "Google OAuth", hostname: "imap.gmail.com", port: 993, authentication: "google-oauth2" };
export const googleSmtp = { id: "google", label: "Google OAuth SMTP", hostname: "smtp.gmail.com", port: 465, recipients: ["*"], authentication: "google-oauth2" };
export async function googleFixture(browser = false, mail = false, options = {}) {
  const calls = [], unexpected = [], opens = [], sessions = new Map(), mailModes = { imap: {}, smtp: {} }; let mode = "normal", gate = null;
  const h = await createHarness({ GOOGLE_OAUTH_CLIENT_ID: "synthetic.apps.googleusercontent.com", GOOGLE_OAUTH_CLIENT_SECRET: "synthetic-client-secret",
    MAILBOX_KEYRING: JSON.stringify({ active: "k1", keys: { k1: "c5".repeat(32) } }),
    IMAP_ENDPOINTS: JSON.stringify([googleImap]), SMTP_ENDPOINTS: JSON.stringify([googleSmtp]) }, browser, null,
    options.worker ?? (mail ? new URL("./google-oauth-test-worker.ts", import.meta.url) : null), {
    outboundService: async request => {
      const url = new URL(request.url);
      if (mail && url.origin === "https://synthetic-oauth-mail.test") {
        const input = await request.json(); let id = input.id, chunks = [];
        if (url.pathname === "/open") {
          opens.push(input); id = crypto.randomUUID(); const protocol = input.address.hostname.split(".")[0];
          sessions.set(id, { peer: mailAuthPeer(protocol, "tls", mailModes[protocol]), upgraded: false });
          chunks = [protocol === "imap" ? "* OK synthetic\r\n" : "220 synthetic\r\n"];
        } else {
          const session = sessions.get(id); assert.ok(session);
          if (url.pathname === "/upgrade") session.upgraded = true;
          else if (url.pathname === "/write") {
            await options.onMailWrite?.(input); chunks = session.peer.response("tls", input.text);
          }
          else assert.equal(url.pathname, "/close");
        }
        return Response.json({ id, eof: chunks === null, chunks: (chunks ?? []).map(c => ({ base64: Buffer.from(c).toString("base64") })) });
      }
      const body = new URLSearchParams(await request.text());
      calls.push({ url: request.url, method: request.method, body: Object.fromEntries(body), authorization: request.headers.get("authorization") });
      if (url.href === "https://oauth2.googleapis.com/token" && request.method === "POST") {
        if (gate) { const g = gate; gate = null; g.enter(); await g.wait; }
        if (mode === "invalid-grant") return Response.json({ error: "invalid_grant", error_description: "secret-provider-description" }, { status: 400 });
        if (mode === "redirect") return new Response(null, { status: 302, headers: { location: "https://evil.invalid/token" } });
        return Response.json({ access_token: ACCESS, ...(mode === "no-refresh" ? {} : { refresh_token: mode === "rotate" ? REFRESH + "-rotated" : REFRESH }),
          expires_in: ["short", "rotate", "no-refresh"].includes(mode) ? 60 : 3600, token_type: "Bearer",
          scope: mode === "missing-scope" ? "openid email" : "openid email https://mail.google.com/" });
      }
      if (url.href === "https://openidconnect.googleapis.com/v1/userinfo" && request.method === "GET")
        return Response.json({ sub: "synthetic-google-subject", email: mode === "wrong-email" ? "other@example.test" : EMAIL, email_verified: mode !== "unverified" });
      unexpected.push(request.url); return new Response("unexpected external request", { status: 502 });
    }, ...(mail ? { r2Buckets: { INBOX: "google-inbox", OUTBOX: "google-outbox" } } : {}),
  }, mail ? { plugins: [{ name: "synthetic-google-mail-only", setup(build) {
    build.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({ path: fileURLToPath(new URL("./starttls-transport-fixture.ts", import.meta.url)), external: false }));
  } }] } : {});
  const alice = await h.register(`google-${crypto.randomUUID().slice(0, 8)}`), id = options.id ?? crypto.randomUUID();
  const path = `/api/v1/${options.scope === "agent" ? "agent" : "normal"}-accounts/${id}`;
  const input = { expectedRevision: 0, emailAddress: EMAIL, displayName: "Google 测试邮箱", endpointId: "google", username: EMAIL, enabled: false };
  const put = (body = input, key = crypto.randomUUID()) => h.request(path, { method: "PUT", cookie: alice.cookie, headers: { "idempotency-key": key }, body });
  const start = (revision = 1, key = crypto.randomUUID(), extra = {}) => h.request(`${path}/oauth/google/start`, {
    method: "POST", cookie: alice.cookie, headers: { "idempotency-key": key }, body: { expectedRevision: revision }, ...extra });
  const complete = (state, code = "synthetic-authorization-code", extra = {}) => h.request("/api/v1/oauth/google/complete", {
    method: "POST", cookie: alice.cookie, body: { state, code }, ...extra });
  return { h, alice, id, path, input, put, start, complete, calls, opens, sessions, mode(value) { mode = value; }, mailMode(protocol, value) { mailModes[protocol] = value; },
    async authorize() { const created = await put(); assert.equal(created.status, 201, created.text); const started = await start();
      assert.equal(started.status, 200, started.text); const state = new URL(started.body.authorizationUrl).searchParams.get("state");
      const result = await complete(state); assert.equal(result.status, 200, result.text); return result; },
    hold() { let enter, release; const wait = new Promise(resolve => { release = resolve; }); const entered = new Promise(resolve => { enter = resolve; });
      gate = { enter, wait }; return { entered, release }; },
    async close() { if (gate) gate = null; await h.close(); assert.deepEqual(unexpected, []); },
  };
}
