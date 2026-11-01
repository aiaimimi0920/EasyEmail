import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createHarness } from "./runtime-harness.mjs";
import { mutationScenario } from "./normal-mutation-protocol-fixture.mjs";

export async function normalMutationFixture(options = {}) {
  const scenario = mutationScenario(options), opens = [], closes = [], phases = [], gates = new Set();
  const hold = (kind, match) => {
    let enter, release;
    const entered = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Mutation gate not reached")), 20000); timer.unref();
      enter = () => { clearTimeout(timer); resolve(); };
    });
    const wait = new Promise(resolve => { release = resolve; });
    const gate = { kind, match, enter, wait, release }; gates.add(gate); return { entered, release };
  };
  async function pause(kind, value) {
    const gate = [...gates].find(item => item.kind === kind && item.match(value));
    if (gate) { gates.delete(gate); gate.enter(); await gate.wait; }
  }
  const server = createServer(async (request, response) => {
    try {
      let raw = ""; for await (const chunk of request) raw += chunk;
      const input = JSON.parse(raw);
      const send = (value, status = 200) => {
        if (!response.destroyed) { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); }
      };
      if (request.url === "/open") {
        opens.push(input); send({ id: "mutation-fixture", chunks: ["* OK synthetic ready\r\n"] }, options.connectionFailure ? 500 : 200); return;
      }
      if (request.url === "/close") { closes.push(input); await pause("close", input); send({ chunks: [] }); return; }
      if (request.url === "/phase") {
        phases.push(input); await pause("phase", input.phase);
        send({ chunks: [] }, options.rejectPhase === input.phase ? 409 : 200); return;
      }
      await pause("command", input.line);
      // The synthetic server may apply a command and then lose its response.
      const chunks = scenario.handle(input.line);
      send({ chunks }, options.failAfterCommand?.test(input.line) ? 500 : 200);
    } catch { if (!response.destroyed) { response.writeHead(500); response.end(); } }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const module = fileURLToPath(new URL("./normal-imap-transport-fixture.ts", import.meta.url));
  let h;
  try {
    h = await createHarness({ TEST_IMAP_FIXTURE: base }, false, null, new URL("./normal-mutation-test-worker.ts", import.meta.url), {}, {
      plugins: [{ name: "mutation-test-transport", setup(build) {
        build.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({ path: module, external: false }));
      } }],
    });
  } catch (error) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); throw error; }
  return { h, opens, closes, phases, ...scenario,
    mutate(body = {}) { return h.request("/__test/imap-mutation", { method: "POST", body: {
      command: { uid: 2, uidValidity: "42", action: "move" }, source: "Sent", destination: "&Ti1lhw-", ...body } }); },
    holdPhase: phase => hold("phase", value => value === phase), holdCommand: regex => hold("command", value => regex.test(value)),
    holdClose: () => hold("close", () => true),
    async close() {
      for (const gate of gates) { gate.enter(); gate.release(); } gates.clear();
      await h.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    },
  };
}
