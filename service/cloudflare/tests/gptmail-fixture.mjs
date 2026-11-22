import assert from "node:assert/strict";
import { createServer } from "node:http";

// Synthetic HTTP peer for the published GPTMail contract; never a delivery receipt.
export async function gptmailFixture() {
  const calls = [], messages = new Map(), modes = new Map(), replies = new Map(), gates = new Map();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1"), address = url.searchParams.get("email");
    calls.push({ path: url.pathname, query: url.searchParams, method: request.method, headers: request.headers });
    const send = (data, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(data)); };
    try {
      assert.equal(request.headers["x-api-key"], "synthetic-gptmail-key");
      assert.equal(request.method, "GET"); assert.ok(address?.endsWith("@gptmail.example.test"));
      assert.deepEqual([...url.searchParams.keys()], ["email"]);
      const gate = gates.get(url.pathname);
      if (gate) { gates.delete(url.pathname); gate.enter(); await gate.wait; }
      const mode = modes.get(url.pathname);
      if (mode === "redirect") { response.writeHead(302, { location: "/exfiltrate" }); response.end(); return; }
      if (mode === "disconnect") { response.destroy(); return; }
      if (mode === "invalid") { response.writeHead(200, { "content-type": "application/json" }); response.end("not JSON"); return; }
      if (mode === "html") { response.writeHead(200, { "content-type": "text/html" }); response.end("synthetic-private-error"); return; }
      if (mode === "oversized") { send({ body: "x".repeat(2 * 1024 * 1024) }); return; }
      if (typeof mode === "number") { send({ success: false, error: "synthetic-private-error" }, mode); return; }
      if (replies.has(url.pathname)) { send(replies.get(url.pathname)); return; }
      const rows = messages.get(address) ?? [];
      if (url.pathname === "/api/emails") { send({ success: true, data: { emails: rows, count: rows.length } }); return; }
      const match = /^\/api\/email\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
      const row = match && rows.find(value => value.id === match[1]);
      send(row ? { success: true, data: row } : {}, row ? 200 : 404);
    } catch (error) { send({ fixtureError: error.message }, 500); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const config = { id: "gptmail", type: "gptmail", baseUrl: `http://127.0.0.1:${server.address().port}`,
    domains: ["gptmail.example.test"], enabled: true, sendRecipients: [] };
  return { calls, messages, modes, replies, config,
    bindings: { PROVIDER_CONFIG: JSON.stringify([config]), PROVIDER_SECRETS: JSON.stringify({ gptmail: { apiKey: "synthetic-gptmail-key" } }),
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

export function gptMail(address, n = 1) {
  return { id: `mail-${String(n).padStart(3, "0")}`, email_address: address, from_address: "noreply@example.test",
    subject: `GPT verify ${n}`, content: "Your verification code is 735296.",
    html_content: '<b>735296</b><script>window.gptExecuted=true</script>', has_html: true,
    timestamp: Math.floor(Date.now() / 1000), created_at: new Date().toISOString() };
}
