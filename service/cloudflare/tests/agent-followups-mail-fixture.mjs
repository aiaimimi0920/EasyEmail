import { createServer } from "node:http";
import { agentFollowupsFixture } from "./agent-followups-fixture.mjs";
import { readScenario } from "./normal-read-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";
import { agentReply } from "./agent-inbox-fixture.mjs";

export const followupReply = (messageId, options) => new TextEncoder().encode(new TextDecoder().decode(agentReply(messageId, options))
  .replace("To: alice@example.test", "To: sender@example.test"));

export async function agentFollowupsMailFixture(options = {}) {
  let scenario = readScenario({ messages: new Map(), uidNext: 1 });
  const t = await agentFollowupsFixture({ browser: options.browser ?? false, testEntry: new URL("./agent-followups-mail-worker.ts", import.meta.url),
    transport: new URL("./agent-followups-transport-fixture.ts", import.meta.url), resources: { r2Buckets: { INBOX: "agent-followups-inbox" } } });
  const server = createServer(async (request, response) => {
    try {
      let raw = ""; for await (const chunk of request) raw += chunk;
      const input = JSON.parse(raw);
      const value = request.url === "/open" ? { id: crypto.randomUUID(), chunks: ["* OK synthetic ready\r\n"] }
        : { chunks: scenario.handle(input.line).map(part => typeof part === "string" ? part : { base64: Buffer.from(part).toString("base64") }) };
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value));
    } catch (error) { response.writeHead(500); response.end("synthetic IMAP failure"); console.error(error); }
  });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    await t.h.restart({ TEST_IMAP_FIXTURE: `http://127.0.0.1:${server.address().port}` });
    const base = `/api/v1/agent-accounts/${t.accountId}`;
    return { ...t, base,
      scenario(value) { scenario = readScenario(value); },
      receive: () => t.h.request(`${base}/sync`, { method: "POST", cookie: t.alice.cookie, body: { expectedRevision: 1 }, headers: { "idempotency-key": crypto.randomUUID() } }),
      inbox: (query = "") => t.h.request(`${base}/messages${query}`, { cookie: t.alice.cookie }),
      async inbound(message) {
        return expect(await t.h.request(`${base}/messages/${message.id}/inbound-thread`, { method: "PUT", cookie: t.alice.cookie,
          headers: { "idempotency-key": crypto.randomUUID() }, body: { accountRevision: 1, epochId: message.epochId, expectedRevision: message.review.revision,
            serviceId: t.serviceId, serviceVersion: 1, confirmRestricted: false } }), 201).operation.threadId;
      },
      async close() { await t.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
    };
  } catch (error) { await t.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); throw error; }
}
