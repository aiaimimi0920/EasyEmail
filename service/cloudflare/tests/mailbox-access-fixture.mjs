import assert from "node:assert/strict";
import { createServer } from "node:http";
import { upstreamFixture } from "./upstream-fixture.mjs";
import { createHarness } from "./runtime-harness.mjs";

export async function mailboxAccessFixture(browser = false, through = null) {
  const upstream = await upstreamFixture(), calls = [], modes = new Map(), gates = new Map();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, upstream.baseUrl);
      calls.push({ path: url.pathname, method: request.method, admin: !!request.headers["x-admin-auth"] });
      const gate = gates.get(url.pathname);
      if (gate) { gates.delete(url.pathname); gate.enter(); await gate.wait; }
      const mode = modes.get(url.pathname);
      if (typeof mode === "number") { response.writeHead(mode, { "content-type": "application/json" }); response.end('{}'); return; }
      if (mode && typeof mode === "object") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(mode)); return; }
      const headers = { ...request.headers }; delete headers.host; delete headers['content-length']; delete headers['accept-encoding'];
      const result = await upstream.request(url.pathname + url.search, { method: request.method, site: false, headers });
      const outbound = Object.fromEntries(result.headers); delete outbound['content-length']; delete outbound['content-encoding'];
      response.writeHead(result.status, outbound); response.end(result.text);
    } catch { response.writeHead(502, { "content-type": "application/json" }); response.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const configs = JSON.parse(upstream.bindings.PROVIDER_CONFIG);
  configs[0].baseUrl = `http://127.0.0.1:${server.address().port}`;
  let h;
  try { h = await createHarness({ ...upstream.bindings, PROVIDER_CONFIG: JSON.stringify(configs) }, browser, through); }
  catch (error) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await upstream.close(); throw error; }
  const alice = await h.register(`access-${crypto.randomUUID()}`);
  return { upstream, h, alice, calls, modes,
    input: box => ({ providerId: "self", address: box.address, token: box.jwt }),
    recover(input, key = crypto.randomUUID(), extra = {}) {
      return h.request("/api/v1/mailbox-access-recoveries", { method: "POST", cookie: alice.cookie,
        body: input, headers: { "idempotency-key": key }, ...extra });
    },
    receipt(key, extra = {}) { return h.request(`/api/v1/mailbox-access-recoveries/${key}`, { cookie: alice.cookie, ...extra }); },
    hold(route = "/api/mailbox_identity") {
      let enter, release;
      const entered = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error(`Recovery gate not reached: ${route}`)), 10000); timer.unref();
        enter = () => { clearTimeout(timer); resolve(); };
      });
      const wait = new Promise(resolve => { release = resolve; }); gates.set(route, { enter, wait });
      return { entered, release };
    },
    async close() { await h.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await upstream.close(); },
  };
}

export function assertReadOnlyProof(t, count) {
  assert.equal(t.calls.length, count);
  assert.ok(t.calls.every(call => call.method === "GET" && call.path === "/api/mailbox_identity" && !call.admin));
}
