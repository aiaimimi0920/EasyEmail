import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createHarness } from "./runtime-harness.mjs";

export const SMTP_PASSWORD = "Synthetic-SMTP-app-password-45931";
export const smtpEndpoint = { id: "example", label: "测试 SMTP", hostname: "smtp.example.test", port: 465, recipients: ["*"] };
export const smtpInput = { expectedRevision: 1, smtpRevision: 0, endpointId: "example", username: "Alice", password: SMTP_PASSWORD, enabled: true };
export const mailInput = { expectedRevision: 1, smtpRevision: 1, to: "receiver@example.test", subject: "普通邮箱验收", text: "正文\n.\r\n你好" };
export async function normalSendFixture(browser = false, resources = {}, testEntry = new URL("./normal-send-test-worker.ts", import.meta.url), transport) {
  const opens = [], writes = [], messages = [], sessions = new Map(); let mode = "normal", gate;
  const server = createServer(async (req, res) => {
    try {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const input = JSON.parse(raw), reply = (chunks, eof = false, id) => {
        if (!res.destroyed) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ chunks, eof, id })); }
      };
      const stall = () => new Promise(resolve => { const timer = setTimeout(resolve, 20000); timer.unref(); res.once("close", () => { clearTimeout(timer); resolve(); }); });
      if (req.url === "/open") {
        opens.push(input); const id = crypto.randomUUID(); sessions.set(id, { mode });
        if (mode === "stall-greeting") await stall();
        reply([mode === "oversized-greeting" ? "220 " + "x".repeat(600) + "\r\n" : "220 synthetic SMTP\r\n"], false, id); return;
      }
      const s = sessions.get(input.id), text = input.text; writes.push(text);
      if (s.data) {
        s.data = false; messages.push(text);
        if (gate) { const g = gate; gate = null; g.enter(); await g.wait; }
        if (s.mode === "stall-final") await stall();
        if (s.mode === "drop-final") return reply([], true);
        if (s.mode === "invalid-final") return reply(["250-continuation\r\n550 inconsistent\r\n"]);
        return reply([s.mode === "final-reject" ? "554 secret-rejection-text\r\n" : "250 message queued\r\n"]);
      }
      if (text.startsWith("EHLO ")) return reply([s.mode === "no-auth" ? "250 synthetic\r\n" : `250-synthetic\r\n250-${s.mode === "lowercase-auth" ? "auth" : "AUTH"} PLAIN LOGIN\r\n250 SIZE 50000\r\n`]);
      if (text.startsWith("AUTH PLAIN ")) {
        assert.equal(Buffer.from(text.slice(11).trim(), "base64").toString(), `\0Alice\0${SMTP_PASSWORD}`);
        return reply([s.mode === "auth-reject" ? "535 secret-auth-text\r\n" : "235 authenticated\r\n"]);
      }
      if (text.startsWith("MAIL FROM:")) return reply(["250 sender ok\r\n"]);
      if (text.startsWith("RCPT TO:")) return reply([s.mode === "rcpt-reject" ? "550 secret-rcpt-text\r\n" : "250 recipient ok\r\n"]);
      if (text === "DATA\r\n") { s.data = true; return reply(["354 continue\r\n"]); }
      throw new Error(`Unexpected synthetic SMTP write ${text.slice(0, 20)}`);
    } catch (error) { res.writeHead(500); res.end("synthetic fixture failure"); console.error(error); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const bindings = { TEST_SMTP_FIXTURE: `http://127.0.0.1:${server.address().port}`, SMTP_ENDPOINTS: JSON.stringify([smtpEndpoint]),
    IMAP_ENDPOINTS: JSON.stringify([{ id: "example", label: "Test IMAP", hostname: "imap.example.test", port: 993 }]),
    MAILBOX_KEYRING: JSON.stringify({ active: "k1", keys: { k1: "c5".repeat(32) } }) };
  const module = fileURLToPath(transport ?? new URL("./smtp-transport-fixture.ts", import.meta.url));
  let h;
  try { h = await createHarness(bindings, browser, null, testEntry, resources, {
    plugins: [{ name: "synthetic-smtp-transport-only", setup(build) { build.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({ path: module, external: false })); } }],
  }); } catch (error) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); throw error; }
  const alice = await h.register(`smtp-${crypto.randomUUID().slice(0, 8)}`), id = crypto.randomUUID(), path = `/api/v1/normal-accounts/${id}`;
  const account = await h.request(path, { method: "PUT", cookie: alice.cookie, headers: { "idempotency-key": crypto.randomUUID() },
    body: { expectedRevision: 0, emailAddress: "alice@example.test", displayName: "普通发信邮箱", endpointId: "example", username: "Alice", password: "Synthetic-IMAP-password", enabled: true } });
  assert.equal(account.status, 201, account.text);
  return { h, alice, id, path, opens, writes, messages, bindings, mode(value) { mode = value; },
    configure(body = smtpInput, key = crypto.randomUUID()) { return h.request(`${path}/smtp`, { method: "PUT", cookie: alice.cookie, headers: { "idempotency-key": key }, body }); },
    send(body = mailInput, key = crypto.randomUUID(), extra = {}) { return h.request(`${path}/send`, { method: "POST", cookie: alice.cookie, headers: { "idempotency-key": key }, body, ...extra }); },
    hold() { let enter, release; const wait = new Promise(resolve => { release = resolve; }); const entered = new Promise(resolve => { enter = resolve; }); gate = { enter, wait }; return { entered, release }; },
    async close() { if (gate) { gate.enter(); gate = null; } await h.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
