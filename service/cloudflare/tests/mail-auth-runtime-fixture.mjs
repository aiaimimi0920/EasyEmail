import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createHarness } from "./runtime-harness.mjs";
import { mailAuthPeer } from "./mail-auth-peer-fixture.mjs";

export async function mailAuthFixture() {
  const opens = [], sessions = new Map(), modes = { imap: {}, smtp: {} };
  const server = createServer(async (req, res) => {
    try {
      let raw = ""; for await (const chunk of req) raw += chunk; const input = JSON.parse(raw);
      let chunks = [], id = input.id;
      if (req.url === "/open") {
        opens.push(input); id = crypto.randomUUID();
        const protocol = input.address.hostname.split(".")[0], security = input.options.secureTransport === "starttls" ? "starttls" : "tls";
        sessions.set(id, { peer: mailAuthPeer(protocol, security, modes[protocol]), security, upgraded: false });
        chunks = [protocol === "imap" ? "* OK synthetic\r\n" : "220 synthetic\r\n"];
      } else {
        const session = sessions.get(id); assert.ok(session);
        if (req.url === "/upgrade") { assert.equal(session.upgraded, false); session.upgraded = true; }
        else if (req.url === "/write") {
          assert.equal(input.stage, session.upgraded ? "tls" : "plain");
          chunks = session.peer.response(session.security === "tls" || session.upgraded ? "tls" : "plain", input.text);
        } else assert.equal(req.url, "/close");
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id, eof: chunks === null, chunks: (chunks ?? []).map(c => ({ base64: Buffer.from(c).toString("base64") })) }));
    } catch (error) { res.writeHead(500); res.end("synthetic mail-auth fixture failure"); console.error(error); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); let h;
  try {
    const module = fileURLToPath(new URL("./starttls-transport-fixture.ts", import.meta.url));
    h = await createHarness({ TEST_MAIL_AUTH_FIXTURE: `http://127.0.0.1:${server.address().port}`,
      IMAP_ENDPOINTS: JSON.stringify([{ id: "example", label: "Synthetic", hostname: "imap.example.test", port: 993 }]),
      SMTP_ENDPOINTS: JSON.stringify([{ id: "example", label: "Synthetic", hostname: "smtp.example.test", port: 465, recipients: ["*"] }]),
      MAILBOX_KEYRING: JSON.stringify({ active: "k1", keys: { k1: "c5".repeat(32) } }) }, false, null, new URL("./mail-auth-test-worker.ts", import.meta.url), {}, {
      plugins: [{ name: "synthetic-mail-auth-only", setup(build) { build.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({ path: module, external: false })); } }],
    });
    return { h, opens, sessions, mode(protocol, options) { modes[protocol] = options; },
      async close() { await h.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
  } catch (error) { await h?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); throw error; }
}
