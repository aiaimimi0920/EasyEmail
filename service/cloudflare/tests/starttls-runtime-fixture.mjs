import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createHarness } from "./runtime-harness.mjs";
import { starttlsPeer } from "./starttls-peer-fixture.mjs";

export const imapStarttls = { id: "example", label: "IMAP 升级", hostname: "imap.example.test", port: 143, security: "starttls" };
export const smtpStarttls = { id: "example", label: "SMTP 升级", hostname: "smtp.example.test", port: 587, security: "starttls", recipients: ["*"] };
export const accountInput = { expectedRevision: 0, emailAddress: "alice@example.test", displayName: "升级邮箱", endpointId: "example", username: "Alice", password: "Synthetic-STARTTLS-IMAP-secret", enabled: true };
export const configInput = { expectedRevision: 1, smtpRevision: 0, endpointId: "example", username: "Alice", password: "Synthetic-STARTTLS-SMTP-secret", enabled: true };
export const sendInput = { expectedRevision: 1, smtpRevision: 1, to: "receiver@example.test", subject: "升级邮件", text: "升级后提交的正文" };
export async function starttlsFixture(browser = false) {
  const opens = [], sessions = new Map(), events = [], modes = { imap: "normal", smtp: "normal" };
  const server = createServer(async (req, res) => {
    try {
      let raw = ""; for await (const chunk of req) raw += chunk; const input = JSON.parse(raw);
      let chunks = [], id = input.id;
      if (req.url === "/open") {
        opens.push(input); id = crypto.randomUUID(); const protocol = input.address.port === 143 ? "imap" : "smtp";
        sessions.set(id, { peer: starttlsPeer(protocol, modes[protocol]), upgraded: false });
        chunks = [protocol === "imap" ? "* OK synthetic IMAP\r\n" : "220 synthetic SMTP\r\n"];
      } else {
        const session = sessions.get(id); assert.ok(session);
        events.push({ action: req.url, ...input });
        if (req.url === "/upgrade") { assert.equal(session.upgraded, false); session.upgraded = true; }
        else if (req.url === "/write") {
          assert.equal(input.stage, session.upgraded ? "tls" : "plain"); chunks = session.peer.response(input.stage, input.text);
        } else assert.equal(req.url, "/close");
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id, eof: chunks === null, chunks: (chunks ?? []).map(c => ({ base64: Buffer.from(c).toString("base64") })) }));
    } catch (error) { res.writeHead(500); res.end("synthetic STARTTLS fixture failure"); console.error(error); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const bindings = { TEST_STARTTLS_FIXTURE: `http://127.0.0.1:${server.address().port}`, IMAP_ENDPOINTS: JSON.stringify([imapStarttls]),
    SMTP_ENDPOINTS: JSON.stringify([smtpStarttls]), MAILBOX_KEYRING: JSON.stringify({ active: "k1", keys: { k1: "c5".repeat(32) } }) };
  const module = fileURLToPath(new URL("./starttls-transport-fixture.ts", import.meta.url)); let h;
  try {
    h = await createHarness(bindings, browser, null, new URL("./starttls-test-worker.ts", import.meta.url), { r2Buckets: { INBOX: "synthetic-inbox", OUTBOX: "synthetic-outbox" } }, {
      plugins: [{ name: "synthetic-starttls-only", setup(build) { build.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({ path: module, external: false })); } }],
    });
    const alice = await h.register(`starttls-${crypto.randomUUID().slice(0, 8)}`), id = crypto.randomUUID(), path = `/api/v1/normal-accounts/${id}`;
    const write = (suffix, body, key = crypto.randomUUID(), method = "POST") => h.request(path + suffix, { method, cookie: alice.cookie, headers: { "idempotency-key": key }, body });
    assert.equal((await write("", accountInput, undefined, "PUT")).status, 201);
    return { h, alice, id, path, bindings, opens, sessions, events, mode(protocol, value) { modes[protocol] = value; },
      save(body, key) { return write("", body, key, "PUT"); }, configure(body = configInput, key) { return write("/smtp", body, key, "PUT"); },
      test(revision = 1) { return write("/test", { expectedRevision: revision }); },
      receive(key, revision = 1) { return write("/sync", { expectedRevision: revision }, key); },
      send(body = sendInput, key) { return write("/send", body, key); },
      async close() { await h.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
    };
  } catch (error) { await h?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); throw error; }
}
