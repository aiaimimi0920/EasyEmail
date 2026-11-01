import assert from "node:assert/strict";
import { createServer } from "node:http";

export async function im215Fixture() {
  const calls = [], accounts = new Map(), messages = new Map(), modes = new Map(), patches = new Map(), replies = new Map(), gates = new Map();
  let lifetime = 3600;
  const profile = account => ({ id: account.id, address: account.address, isActive: true, inboxType: "temp", source: "api", expiresAt: account.expiresAt });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1"), route = url.pathname.slice(3); let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined; calls.push({ route, method: request.method, headers: request.headers, query: url.searchParams, body });
    const send = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    const data = (value, status = 200) => send({ success: true, data: { ...value, ...patches.get(route) } }, status);
    try {
      assert.ok(url.pathname.startsWith("/v1/")); const mode = modes.get(route), gate = gates.get(route);
      if (gate) { gates.delete(route); gate.enter(); await gate.wait; }
      if (mode === "redirect") { response.writeHead(302, { location: "https://invalid.example/exfiltrate" }); response.end(); return; }
      if (mode === "invalid") { response.writeHead(200, { "content-type": "application/json" }); response.end("not JSON"); return; }
      if (mode === "html") { response.writeHead(200, { "content-type": "text/html" }); response.end("synthetic-private-error"); return; }
      if (mode === "oversized") { send({ value: "x".repeat(2 * 1024 * 1024) }); return; }
      if (typeof mode === "number") { send({ success: false, error: "synthetic-private-error" }, mode); return; }
      if (replies.has(route)) { send(replies.get(route)); return; }
      if (route === "/domains") {
        assert.equal(request.method, "GET");
        send({ success: true, data: [{ id: "domain-1", domain: "im215.example.test", isVerified: true, isMxValid: true },
          { id: "domain-2", domain: "notready.example.test", isVerified: true, isMxValid: false }] }); return;
      }
      if (route === "/accounts") {
        assert.equal(request.method, "POST"); assert.equal(request.headers["x-api-key"], "AC-synthetic-im215-platform-key");
        assert.deepEqual(Object.keys(body).sort(), ["domain", "localPart"]); assert.match(body.localPart, /^ee[a-f0-9]{32}$/);
        assert.equal(body.domain, "im215.example.test"); assert.match(request.headers["idempotency-key"], /^ee-[a-f0-9]{64}$/);
        const address = `${body.localPart}@${body.domain}`; assert.equal(accounts.has(address), false);
        const n = accounts.size + 1, account = { id: `inbox-${n}`, address, token: `synthetic-im215-token-${n}`,
          expiresAt: lifetime === null ? null : new Date(Date.now() + lifetime * 1000).toISOString() };
        accounts.set(address, account);
        if (mode === "lost-ack") { response.destroy(); return; }
        data({ ...profile(account), mode: "fixed", domain: body.domain, token: account.token }, 201); return;
      }
      assert.equal(request.method, "GET"); assert.equal(request.headers["x-api-key"], undefined);
      const account = [...accounts.values()].find(row => request.headers.authorization === `Bearer ${row.token}`);
      assert.ok(account, "Mailbox token must be used, never a platform API Key");
      if (route === "/accounts/me") { data(profile(account)); return; }
      const inbox = /^\/inboxes\/([^/]+)\/messages$/.exec(route), rows = [...(messages.get(account.address) ?? [])].sort((a, b) => b.id.localeCompare(a.id));
      if (inbox) {
        assert.equal(inbox[1], account.id); assert.equal(url.searchParams.get("limit"), "10"); assert.equal(url.searchParams.get("since"), "1970-01-01T00:00:00Z");
        assert.equal(url.searchParams.has("offset"), false); const cursor = url.searchParams.get("after_id"), offset = cursor ? rows.findIndex(row => row.id === cursor) + 1 : 0;
        assert.ok(!cursor || offset > 0); const page = rows.slice(offset, offset + 10), more = offset + 10 < rows.length;
        data({ messages: page.map(({ text, html, attachments, ...row }) => row), total: rows.length, unreadCount: rows.length, nextCursor: more ? page.at(-1).id : "" }); return;
      }
      const match = /^\/messages\/([^/]+)$/.exec(route); assert.ok(match); assert.equal(url.searchParams.get("address"), account.address);
      const mail = rows.find(row => row.id === match[1]); if (!mail) { send({ success: false, errorCode: "message_not_found" }, 404); return; }
      data(mail);
    } catch (error) { send({ fixtureError: error.message }, 500); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const config = { id: "im215", type: "im215", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, domains: ["im215.example.test"], enabled: true, sendRecipients: [] };
  return { calls, accounts, messages, modes, patches, replies, config, profile, setLifetime(value) { lifetime = value; },
    bindings: { PROVIDER_CONFIG: JSON.stringify([config]), PROVIDER_SECRETS: JSON.stringify({ im215: { apiKey: "AC-synthetic-im215-platform-key" } }),
      MAILBOX_KEYRING: JSON.stringify({ active: "k1", keys: { k1: "a3".repeat(32) } }) },
    hold(route) {
      let enter, release;
      const entered = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`Fixture gate not reached: ${route}`)), 10000); timer.unref();
        enter = () => { clearTimeout(timer); resolve(); }; });
      const wait = new Promise(resolve => { release = resolve; }); gates.set(route, { enter, wait }); return { entered, release };
    },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

export function im215Mail(account, n = 1) {
  return { id: `mail-${String(n).padStart(5, "0")}`, inboxId: account.id, inbox_id: account.id, to: [{ address: account.address }],
    from: { address: "noreply@example.test" }, subject: `215 verify ${n}`, createdAt: new Date().toISOString(), seen: false,
    text: "Your verification code is 852471.", html: ['<b>852471</b><img src="https://invalid.example/pixel"><script>window.im215Executed=true</script>'],
    hasAttachments: true, attachments: [{ id: "0", filename: "sample.txt", contentType: "text/plain", size: 19, downloadUrl: "/serve/mail?token=synthetic-private-url" }] };
}
