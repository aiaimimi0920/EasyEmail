import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createHarness } from "./runtime-harness.mjs";
import { readScenario } from "./normal-read-fixture.mjs";
import { normalInput } from "./normal-imap-fixture.mjs";

export async function normalSyncFixture(options = {}) {
  const scenarioFactory = options.scenarioFactory ?? readScenario;
  let scenario = scenarioFactory(options), gate, commandGate, failedPut = false;
  const opens = [], calls = [], failedOperations = new Set();
  const server = createServer(async (request, response) => {
    const send = value => { if (!response.destroyed) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); } };
    if (gate?.path === request.url) { const current = gate; gate = null; current.enter(); await current.wait; }
    if (["/put", "/head", "/get", "/after-put", "/delete", "/after-delete"].includes(request.url)) {
      if (failedPut && request.url === "/put" || failedOperations.has(request.url)) { response.writeHead(500); response.end("private-storage-error"); } else send({});
      return;
    }
    let raw = ""; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    if (request.url === "/open") { opens.push(input); send({ id: crypto.randomUUID(), chunks: ["* OK synthetic ready\r\n"] }); return; }
    if (request.url === "/close") { send({ chunks: [] }); return; }
    calls.push(input.line);
    if (commandGate?.pattern.test(input.line)) { const current = commandGate; commandGate = null; current.enter(); await current.wait; }
    send({ chunks: scenario.handle(input.line, input.id).map(part => typeof part === "string" ? part : { base64: Buffer.from(part).toString("base64") }) });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const module = fileURLToPath(new URL("./normal-imap-transport-fixture.ts", import.meta.url));
  let h;
  try {
    h = await createHarness({ TEST_IMAP_FIXTURE: base,
      IMAP_ENDPOINTS: JSON.stringify([{ id: "example", label: "测试", hostname: "imap.example.test", port: 993 }]),
      MAILBOX_KEYRING: JSON.stringify({ active: "k1", keys: { k1: "c5".repeat(32) } }), ...options.bindings }, options.browser ?? false, options.through ?? null,
    new URL(options.testEntry ?? (options.public ? "./normal-access-test-worker.ts" : "./normal-sync-test-worker.ts"), import.meta.url), options.noBucket ? {} : { r2Buckets: { INBOX: "normal-inbox-fixture" } }, {
      plugins: [{ name: "normal-sync-test-transport", setup(build) { build.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({ path: module, external: false })); } }],
    });
    const alice = await h.register(`sync-${crypto.randomUUID().slice(0, 8)}`), id = crypto.randomUUID();
    const accountPath = options.agent ? "agent-accounts" : "normal-accounts";
    const save = (fields = {}, revision = 0, cookie = alice.cookie, accountId = id) => h.request(`/api/v1/${accountPath}/${accountId}`, {
      method: "PUT", cookie, headers: { "idempotency-key": crypto.randomUUID() }, body: { ...normalInput, ...fields, expectedRevision: revision } });
    assert.equal((await save()).status, 201);
    return { h, alice, id, calls, opens, save,
      sync(revision = 1, extra = {}) { return h.request("/__test/normal-sync", { method: "POST", cookie: alice.cookie, body: { accountId: id, expectedRevision: revision }, ...extra }); },
      scenario(value) { scenario = scenarioFactory(value); }, failPut(value = true) { failedPut = value; },
      holdCommand(pattern) {
        let enter, release;
        const entered = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("IMAP command gate not reached")), 15000); timer.unref(); enter = () => { clearTimeout(timer); resolve(); }; });
        const wait = new Promise(resolve => { release = resolve; }); commandGate = { pattern, enter, wait };
        return { entered, release };
      },
      failOperation(path, value = true) { if (value) failedOperations.add(path); else failedOperations.delete(path); },
      async state() { return h.db.prepare("SELECT * FROM normal_inbox_state WHERE account_id=?").bind(id).first(); },
      holdPut(path = "/put") {
        let enter, release;
        const entered = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("R2 stage gate not reached")), 15000); timer.unref(); enter = () => { clearTimeout(timer); resolve(); }; });
        const wait = new Promise(resolve => { release = resolve; }); gate = { enter, wait, path };
        return { entered, release };
      },
      async close() { await h.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
    };
  } catch (error) { await h?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); throw error; }
}
