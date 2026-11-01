import assert from "node:assert/strict";
import { createServer } from "node:http";

// Independent loopback contract peer, not a real provider or a delivery receipt.
export async function moemailFixture() {
  const calls = [], mailboxes = new Map(), messages = new Map(), modes = new Map(), replies = new Map(), gates = new Map();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ path: url.pathname, query: url.searchParams, method: request.method, headers: request.headers, body });
    const send = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    try {
      assert.equal(request.headers["x-api-key"], "synthetic-moemail-key");
      assert.equal(request.headers.authorization, undefined);
      const gate = gates.get(url.pathname);
      if (gate) { gates.delete(url.pathname); gate.enter(); await gate.wait; }
      const mode = modes.get(url.pathname);
      if (mode === "disconnect") { response.destroy(); return; }
      if (mode === "redirect") { response.writeHead(302, { location: "/exfiltrate" }); response.end(); return; }
      if (mode === "invalid") { response.writeHead(200, { "content-type": "application/json" }); response.end("not JSON"); return; }
      if (mode === "oversized") { send({ body: "x".repeat(2 * 1024 * 1024) }); return; }
      if (typeof mode === "number") { send({ error: "synthetic-private-error" }, mode); return; }
      if (replies.has(url.pathname)) { send(replies.get(url.pathname)); return; }
      if (url.pathname === "/api/config") { send({ emailDomains: "moemail.example.test,other.example.test" }); return; }
      if (url.pathname === "/api/emails/generate" && request.method === "POST") {
        assert.equal(body.expiryTime, 3600000);
        const address = `${body.name}@${body.domain}`, id = `moe-${mailboxes.size + 1}`;
        assert.ok(!mailboxes.has(address)); mailboxes.set(address, { id, address });
        if (mode === "lost-ack") { response.destroy(); return; }
        send({ id, email: address }); return;
      }
      const match = /^\/api\/emails\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
      if (match) {
        const mailbox = [...mailboxes.values()].find(row => row.id === decodeURIComponent(match[1]));
        if (!mailbox) { send({}, 403); return; }
        const rows = messages.get(mailbox.address) ?? [];
        if (match[2]) {
          const message = rows.find(row => row.id === decodeURIComponent(match[2]));
          send(message ? { message } : {}, message ? 200 : 404); return;
        }
        const cursor = url.searchParams.get("cursor"), offset = cursor ? Number(cursor.replace("cursor+/", "")) : 0;
        assert.ok(Number.isSafeInteger(offset) && offset >= 0);
        send({ messages: rows.slice(offset, offset + 20), nextCursor: offset + 20 < rows.length ? `cursor+/${offset + 20}` : null, total: rows.length }); return;
      }
      send({}, 404);
    } catch (error) { send({ fixtureError: error.message }, 500); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const config = { id: "moemail", type: "moemail", baseUrl, domains: [], enabled: true, sendRecipients: [] };
  return { calls, mailboxes, messages, modes, replies, config,
    bindings: { PROVIDER_CONFIG: JSON.stringify([config]), PROVIDER_SECRETS: JSON.stringify({ moemail: { apiKey: "synthetic-moemail-key" } }),
      MAILBOX_KEYRING: JSON.stringify({ active: "k1", keys: { k1: "a3".repeat(32) } }) },
    hold(path) {
      let enter, release;
      const entered = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Fixture gate not reached: ${path}`)), 10000); timer.unref();
        enter = () => { clearTimeout(timer); resolve(); };
      });
      const wait = new Promise(resolve => { release = resolve; });
      gates.set(path, { enter, wait }); return { entered, release };
    },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

export function moeMail(address, n = 1) {
  return { id: `message-${n}`, from_address: "noreply@example.test", to_address: address,
    subject: `Verify ${n}`, content: "Your verification code is 735296.",
    html: '<b>735296</b><script>window.moeExecuted=true</script>', type: "received", received_at: Date.now() };
}
