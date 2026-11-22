import assert from "node:assert/strict";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHarness } from "./runtime-harness.mjs";

export async function remoteAllocationFixture(browser = false) {
  const calls = [], allocations = [], modes = new Set(), patches = new Map(), gates = new Map();
  const server = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk; calls.push({ method: request.method, path: request.url, body: JSON.parse(raw || "null") });
    try {
      assert.equal(request.url, "/allocate"); assert.equal(request.method, "POST"); assert.deepEqual(JSON.parse(raw), { domain: "remote.example.test" });
      const gate = gates.get("allocate"); if (gate) { gates.delete("allocate"); gate.enter(); await gate.wait; }
      const n = allocations.length + 1, value = { address: `server${n}@remote.example.test`, remoteId: `remote-${n}`,
        credential: { token: `synthetic-remote-allocation-${n}` }, expiresAt: Math.floor(Date.now() / 1000) + 1800, ...Object.fromEntries(patches) };
      allocations.push(value); if (modes.has("lost-ack")) { response.destroy(); return; }
      response.writeHead(201, { "content-type": "application/json" }); response.end(JSON.stringify(value));
    } catch (error) { response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ fixtureError: error.message })); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const config = { id: "remote-fixture", type: "cloudflare", baseUrl: `http://127.0.0.1:${server.address().port}`, domains: ["remote.example.test"], enabled: true, sendRecipients: [] };
  const module = fileURLToPath(new URL("./remote-allocation-provider-fixture.ts", import.meta.url)), registry = fileURLToPath(new URL("../src/providers/registry", import.meta.url));
  let h;
  try {
    h = await createHarness({ PROVIDER_CONFIG: JSON.stringify([config]), PROVIDER_SECRETS: JSON.stringify({ "remote-fixture": { apiKey: "synthetic-remote-platform-key" } }),
      MAILBOX_KEYRING: JSON.stringify({ active: "k1", keys: { k1: "a3".repeat(32) } }) }, browser, null, new URL("./remote-allocation-test-worker.ts", import.meta.url), {}, {
      plugins: [{ name: "remote-allocation-contract-only", setup(build) {
        build.onResolve({ filter: /registry$/ }, args => args.importer !== module && path.resolve(path.dirname(args.importer), args.path) === registry ? { path: module } : undefined);
      } }],
    });
  } catch (error) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); throw error; }
  return { h, config, calls, allocations, modes, patches,
    hold() {
      let enter, release;
      const entered = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Remote allocation gate not reached")), 10000); timer.unref(); enter = () => { clearTimeout(timer); resolve(); }; });
      const wait = new Promise(resolve => { release = resolve; }); gates.set("allocate", { enter, wait }); return { entered, release };
    },
    async close() { await h.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

export const remoteAllocate = (h, cookie, key = crypto.randomUUID(), extra = {}) => h.request("/api/v1/mailboxes", { method: "POST", cookie,
  headers: { "idempotency-key": key }, body: { providerId: "remote-fixture", domain: "remote.example.test" }, ...extra });
