import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createHarness } from "./runtime-harness.mjs";

export const IMAP_PASSWORD = "Synthetic-app-password-8593";
export const normalInput = { expectedRevision: 0, emailAddress: "alice@example.test", displayName: "普通邮箱", endpointId: "example", username: "Alice", password: IMAP_PASSWORD, enabled: true };
export async function normalFixture(browser = false) {
  const sessions = new Map(), calls = [], opens = [];
  let mode = "normal", gate;
  const server = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    const send = value => { if (!response.destroyed) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); } };
    if (request.url === "/open") {
      opens.push(input); const id = crypto.randomUUID(); sessions.set(id, {});
      send({ id, chunks: ["* OK synthetic IMAP ready\r\n"] }); return;
    }
    const state = sessions.get(input.id), line = input.line;
    calls.push(line);
    if (state.authTag) {
      const tag = state.authTag; state.authTag = null;
      assert.equal(Buffer.from(line, "base64").toString(), `\0Alice\0${IMAP_PASSWORD}`);
      send({ chunks: [mode === "auth-reject" ? `${tag} NO secret-server-text-must-not-leak\r\n` : `${tag} OK authenticated\r\n`] }); return;
    }
    const [tag, command] = line.split(" ");
    if (command === "CAPABILITY") { send({ chunks: ["* CAPABILITY IMAP4rev1 AUTH=PLAIN IDLE\r\n", `${tag} OK done\r\n`] }); return; }
    if (command === "AUTHENTICATE") { state.authTag = tag; send({ chunks: ["+ \r\n"] }); return; }
    if (command === "EXAMINE") {
      assert.equal(line, `${tag} EXAMINE INBOX`);
      if (gate) { const current = gate; gate = null; current.enter(); await current.wait; }
      const validity = mode === "invalid-validity" ? "0" : "42";
      send({ chunks: [`* 99 EXISTS\r\n* OK [UIDVALIDITY ${validity}] stable\r\n`, `${tag} OK [READ-ONLY] completed\r\n`] }); return;
    }
    assert.equal(command, "LOGOUT"); send({ chunks: [`* BYE done\r\n${tag} OK done\r\n`] });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const bindings = { TEST_IMAP_FIXTURE: base, IMAP_ENDPOINTS: JSON.stringify([{ id: "example", label: "测试 IMAP", hostname: "imap.example.test", port: 993 }]),
    MAILBOX_KEYRING: JSON.stringify({ active: "k1", keys: { k1: "c5".repeat(32) } }) };
  const module = fileURLToPath(new URL("./normal-imap-transport-fixture.ts", import.meta.url));
  const h = await createHarness(bindings, browser, null, new URL("./normal-imap-test-worker.ts", import.meta.url), {}, {
    plugins: [{ name: "synthetic-imap-transport-only", setup(build) { build.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({ path: module, external: false })); } }],
  });
  const alice = await h.register(`normal-live-${crypto.randomUUID().slice(0, 8)}`), id = crypto.randomUUID(), path = `/api/v1/normal-accounts/${id}`;
  const created = await h.request(path, { method: "PUT", cookie: alice.cookie, headers: { "idempotency-key": crypto.randomUUID() }, body: normalInput });
  assert.equal(created.status, 201, created.text);
  return { h, alice, id, path, calls, opens, bindings,
    mode(value) { mode = value; },
    test(revision = 1) { return h.request(`${path}/test`, { method: "POST", cookie: alice.cookie, body: { expectedRevision: revision } }); },
    hold() {
      let enter, release;
      const entered = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("IMAP EXAMINE gate not reached")), 10000); timer.unref(); enter = () => { clearTimeout(timer); resolve(); }; });
      const wait = new Promise(resolve => { release = resolve; }); gate = { enter, wait };
      return { entered, release };
    },
    async close() { gate?.enter(); gate = null; await h.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
