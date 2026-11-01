import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

async function reader(name) {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL(`../web/${name}.ts`, import.meta.url))], bundle: true, write: false, format: "esm", platform: "browser" });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`);
}
const { readAgentInboundOperation } = await reader("agent-inbound-api"), { readAgentThread, readAgentThreadPage } = await reader("agent-threads-api");
const { readAgentIncoming, agentIncomingThreadId } = await reader("agent-inbox-api"), invalid = fn => assert.throws(fn, error => error.status === 502);
test("inbound receipt validates every original field, explicit restricted confirmation, original key and a genuine root ID", () => {
  const attempt = { key: crypto.randomUUID(), accountId: crypto.randomUUID(), messageId: crypto.randomUUID(), body: {
    accountRevision: 2, epochId: crypto.randomUUID(), expectedRevision: 3, serviceId: crypto.randomUUID(), serviceVersion: 4, confirmRestricted: true } };
  const operation = { requestKey: attempt.key, threadId: crypto.randomUUID(), accountId: attempt.accountId, messageId: attempt.messageId, ...attempt.body,
    reviewRevision: 3, completedAt: 100 }; delete operation.expectedRevision;
  assert.deepEqual(readAgentInboundOperation({ operation }, attempt), operation);
  for (const patch of [{ requestKey: crypto.randomUUID() }, { threadId: "bad" }, { accountId: crypto.randomUUID() }, { messageId: crypto.randomUUID() }, { epochId: crypto.randomUUID() },
    { accountRevision: 3 }, { reviewRevision: 4 }, { serviceId: crypto.randomUUID() }, { serviceVersion: 5 }, { confirmRestricted: false }, { completedAt: null }, { completedAt: -1 }])
    invalid(() => readAgentInboundOperation({ operation: { ...operation, ...patch } }, attempt));
  invalid(() => readAgentInboundOperation({}, attempt));
});
test("inbound typed-union DTO cannot contain a fabricated task and preserves manual revision and cross-kind ordering validation", () => {
  const thread = { id: crypto.randomUUID(), kind: "inbound", management: { state: "needs_attention", revision: 1, manual: true, updatedAt: 100 }, inbound: {
    accountId: crypto.randomUUID(), accountRevision: 1, epochId: crypto.randomUUID(), seedMessageId: crypto.randomUUID(), serviceId: crypto.randomUUID(), serviceVersion: 1, createdAt: 100, memberActive: true } };
  assert.deepEqual(readAgentThread({ thread }), thread); assert.deepEqual(readAgentThreadPage({ items: [thread], nextCursor: null }).items, [thread]);
  invalid(() => readAgentThread({ thread: { ...thread, task: {} } })); invalid(() => readAgentThread({ thread: { ...thread, inbound: { ...thread.inbound, memberActive: "true" } } }));
  invalid(() => readAgentThread({ thread: { ...thread, management: { ...thread.management, manual: false } } }));
  invalid(() => readAgentThread({ thread: { ...thread, management: { ...thread.management, revision: 0 } } }));
  invalid(() => readAgentThreadPage({ items: [thread], nextCursor: null }, "open"));
});
test("active inbound membership suppresses the inbox attention queue but never claims an effective task or authenticated sender", () => {
  const accountId = crypto.randomUUID(), row = { id: crypto.randomUUID(), accountId, epochId: crypto.randomUUID(), uid: 1,
    receivedAt: 100, observedAt: 100, subject: "主题", sender: "Agent", recipient: "alice@example.test", association: "unmatched", authentication: "unverified",
    threadId: null, serviceId: null, inboundThread: { id: crypto.randomUUID(), active: true },
    review: { revision: 0, state: "unreviewed", threadId: null, effectiveThreadId: null, needsAttention: false, updatedAt: null } };
  assert.deepEqual(readAgentIncoming(row, accountId), row);
  assert.equal(agentIncomingThreadId(row), row.inboundThread.id);
  invalid(() => readAgentIncoming({ ...row, authentication: "verified" }, accountId));
  invalid(() => readAgentIncoming({ ...row, review: { ...row.review, needsAttention: true } }, accountId));
  invalid(() => readAgentIncoming({ ...row, inboundThread: { ...row.inboundThread, active: "true" } }, accountId));
  const legacy = { ...row, review: { ...row.review, needsAttention: true } }; delete legacy.inboundThread;
  assert.deepEqual(readAgentIncoming(legacy, accountId), legacy);
  assert.equal(agentIncomingThreadId(legacy), null);
});
