import { createServer } from "node:http";

export async function selectGates() {
  const gates = new Map();
  const server = createServer(async (request, response) => {
    const gate = gates.get(decodeURIComponent(request.url.slice(1)));
    if (!gate) { response.writeHead(404).end(); return; }
    gate.enter();
    await gate.released;
    response.writeHead(200).end("released");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    bindings: { TEST_SELECT_GATE: `http://127.0.0.1:${server.address().port}` },
    hold(name, kind) {
      let enter, release;
      const entered = new Promise((resolve) => { enter = resolve; });
      const released = new Promise((resolve) => { release = resolve; });
      gates.set(name, { enter, release, released });
      return { entered: () => Promise.race([entered, new Promise((_, reject) => {
        const timer = setTimeout(() => reject(Error(`Gate not entered: ${name}`)), 10000);
        timer.unref();
      })]), release, headers: { "x-test-pause": name, "x-test-query": kind } };
    },
    async close() {
      for (const gate of gates.values()) gate.release();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
