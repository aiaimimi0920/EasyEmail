import assert from "node:assert/strict";
import { createServer } from "node:http";

// Independent synthetic DuckMail SMTP-account peer. No real mailbox or credentials.
export async function duckmailFixture({ anonymous = false } = {}) {
  const calls = [], accounts = new Map(), messages = new Map(), modes = new Map(), replies = new Map(), gates = new Map();
  const domains = ["duckmail.example.test", ...Array.from({ length: 30 }, (_, n) => `domain${n}.example.test`)];
  const collection = (rows, route, page) => ({ "hydra:member": rows.slice((page - 1) * 30, page * 30), "hydra:totalItems": rows.length,
    "hydra:view": { "@id": `${route}?page=${page}`, "hydra:first": `${route}?page=1`, "hydra:last": `${route}?page=${Math.max(1, Math.ceil(rows.length / 30))}` } });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1"); let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ path: url.pathname, query: url.searchParams, method: request.method, headers: request.headers, body });
    const send = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    try {
      const gate = gates.get(url.pathname);
      if (gate) { gates.delete(url.pathname); gate.enter(); await gate.wait; }
      const mode = modes.get(url.pathname);
      if (mode === "redirect") { response.writeHead(302, { location: "/exfiltrate" }); response.end(); return; }
      if (mode === "invalid") { response.writeHead(200, { "content-type": "application/json" }); response.end("not JSON"); return; }
      if (mode === "html") { response.writeHead(200, { "content-type": "text/html" }); response.end("synthetic-private-error"); return; }
      if (mode === "oversized") { send({ body: "x".repeat(2 * 1024 * 1024) }); return; }
      if (typeof mode === "number") { send({ error: "synthetic-private-error" }, mode); return; }
      if (replies.has(url.pathname)) { send(replies.get(url.pathname)); return; }
      if (url.pathname === "/domains" || url.pathname === "/accounts") assert.equal(request.headers.authorization, anonymous ? undefined : "Bearer dk_synthetic_platform_key");
      if (url.pathname === "/domains") {
        assert.equal(request.method, "GET"); send(collection(domains.map((domain, n) => ({ id: `domain-${n}`, domain, isVerified: true })), "/domains", Number(url.searchParams.get("page") ?? 1))); return;
      }
      if (url.pathname === "/accounts") {
        assert.equal(request.method, "POST"); assert.equal(body.expiresIn, 86400); assert.ok(body.password.length >= 32);
        assert.ok(!accounts.has(body.address));
        const account = { id: `account-${accounts.size + 1}`, address: body.address, password: body.password, token: `synthetic-mailbox-token-${accounts.size + 1}` };
        accounts.set(account.address, account);
        if (mode === "lost-ack") { response.destroy(); return; }
        send({ id: account.id, address: account.address, authType: "email" }, 201); return;
      }
      if (url.pathname === "/token") {
        assert.equal(request.method, "POST"); assert.equal(request.headers.authorization, undefined);
        const account = accounts.get(body.address); assert.equal(body.password, account?.password);
        if (mode === "lost-ack") { response.destroy(); return; }
        send({ id: account.id, token: account.token }); return;
      }
      const account = [...accounts.values()].find(row => request.headers.authorization === `Bearer ${row.token}`);
      assert.ok(account, "Mailbox token is required; the platform API Key must not be used for mail reads");
      assert.equal(request.method, "GET");
      if (url.pathname === "/me") { send({ id: account.id, address: account.address, authType: "email" }); return; }
      const rows = messages.get(account.address) ?? [];
      if (url.pathname === "/messages") { send(collection(rows.map(({ text, html, attachments, ...row }) => row), "/messages", Number(url.searchParams.get("page") ?? 1))); return; }
      const match = /^\/messages\/([a-zA-Z0-9_-]+)$/.exec(url.pathname), row = match && rows.find(value => value.id === match[1]);
      send(row ?? {}, row ? 200 : 404);
    } catch (error) { send({ fixtureError: error.message }, 500); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const config = { id: "duckmail", type: "duckmail", baseUrl: `http://127.0.0.1:${server.address().port}`, domains: [], enabled: true, sendRecipients: [],
    ...(anonymous ? { authentication: "anonymous" } : {}) };
  return { calls, accounts, messages, domains, modes, replies, config, collection,
    bindings: { PROVIDER_CONFIG: JSON.stringify([config]), PROVIDER_SECRETS: JSON.stringify(anonymous ? {} : { duckmail: { apiKey: "dk_synthetic_platform_key" } }),
      MAILBOX_KEYRING: JSON.stringify({ active: "k1", keys: { k1: "a3".repeat(32) } }) },
    hold(path) {
      let enter, release;
      const entered = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Fixture gate not reached: ${path}`)), 10000); timer.unref();
        enter = () => { clearTimeout(timer); resolve(); };
      });
      const wait = new Promise(resolve => { release = resolve; }); gates.set(path, { enter, wait }); return { entered, release };
    },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

export function duckMail(account, n = 1) {
  return { id: `mail-${n}`, accountId: account.id, from: { address: "noreply@example.test", name: "Test sender" }, to: [{ address: account.address }],
    subject: `Duck verify ${n}`, text: "Your verification code is 735296.", html: ['<b>735296</b><script>window.duckExecuted=true</script>'],
    hasAttachments: true, attachments: [{ id: "0", filename: "sample.txt", contentType: "text/plain", size: 19, downloadUrl: "https://invalid.example/exfiltrate" }],
    createdAt: new Date().toISOString() };
}
