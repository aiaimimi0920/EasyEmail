import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createHarness } from "./runtime-harness.mjs";
import { readScenario } from "./normal-read-fixture.mjs";

export async function normalReadFixture(options = {}) {
  const scenario = readScenario(options), opens = [], closes = [];
  let gate, closeGate;
  const server = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    const send = value => {
      if (!response.destroyed) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); }
    };
    if (request.url === "/open") {
      opens.push(input);
      if (options.connectionFailure) { response.writeHead(500); response.end("private-transport-error"); return; }
      send({ id: "reader-fixture", chunks: ["* OK synthetic ready\r\n"] }); return;
    }
    if (request.url === "/close") {
      closes.push(input); if (closeGate) { const current = closeGate; closeGate = null; current.enter(); await current.wait; }
      send({ chunks: [] }); return;
    }
    if (gate && /BODY.PEEK\[\]/.test(input.line)) { const current = gate; gate = null; current.enter(); await current.wait; }
    const chunks = scenario.handle(input.line).map(part => typeof part === "string" ? part : { base64: Buffer.from(part).toString("base64") });
    send({ chunks });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const module = fileURLToPath(new URL("./normal-imap-transport-fixture.ts", import.meta.url));
  let h;
  try {
    h = await createHarness({ TEST_IMAP_FIXTURE: base }, false, null, new URL("./normal-read-test-worker.ts", import.meta.url), {}, {
      plugins: [{ name: "binary-imap-test-transport", setup(build) {
        build.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({ path: module, external: false }));
      } }],
    });
  } catch (error) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); throw error; }
  return { h, opens, closes, calls: scenario.calls,
    read(cursor = null) { return h.request("/__test/imap-read", { method: "POST", body: { cursor } }); },
    holdBody() {
      let enter, release;
      const entered = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("IMAP body gate not reached")), 10000); timer.unref();
        enter = () => { clearTimeout(timer); resolve(); };
      });
      const wait = new Promise(resolve => { release = resolve; }); gate = { enter, wait };
      return { entered, release };
    },
    holdClose() {
      let enter, release;
      const entered = new Promise(resolve => { enter = resolve; });
      const wait = new Promise(resolve => { release = resolve; }); closeGate = { enter, wait };
      return { entered, release };
    },
    async close() {
      gate?.enter(); gate = null;
      await h.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    },
  };
}
