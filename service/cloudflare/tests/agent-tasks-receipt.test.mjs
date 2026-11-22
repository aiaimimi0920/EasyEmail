import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const bundle = await build({ entryPoints: [fileURLToPath(new URL("../web/agent-tasks-api.ts", import.meta.url))], bundle: true, write: false, format: "esm", platform: "browser" });
const { readAgentTask } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`);
test("Agent task receipt validates exact original intention and never promotes malformed or wrong-target success", () => {
  const input = { serviceId: crypto.randomUUID(), serviceVersion: 3, senderAccountId: crypto.randomUUID(), accountRevision: 2, smtpRevision: 4,
    subject: "任务", text: "正文", confirmRestricted: false }, key = crypto.randomUUID(), outgoingId = crypto.randomUUID();
  const task = { ...input, id: crypto.randomUUID(), requestKey: key, outgoingId, messageId: `<${outgoingId}@easyemail.invalid>`,
    state: "queued", threadState: "draft", error: null, revision: 1, from: "from@example.test", to: "to@example.test", cancellable: true,
    retrySafe: false, delivery: "unconfirmed", attempts: 0, nextAttemptAt: 100, deadlineAt: 86500, createdAt: 100, updatedAt: 100, contentPurgedAt: null };
  assert.deepEqual(readAgentTask({ task }, { key, body: input }), task);
  for (const patch of [{ requestKey: crypto.randomUUID() }, { serviceId: crypto.randomUUID() }, { senderAccountId: crypto.randomUUID() }, { accountRevision: 3 },
    { smtpRevision: 5 }, { subject: "changed" }, { text: "changed" }, { state: "delivered" }, { delivery: "confirmed" }, { revision: 0 }, { retrySafe: true },
    { state: "accepted" }, { messageId: "<wrong@example.test>" }, { cancellable: false }, { contentPurgedAt: -1 }])
    assert.throws(() => readAgentTask({ task: { ...task, ...patch } }, { key, body: input }), e => e.status === 502);
  assert.throws(() => readAgentTask({}, { key, body: input }), e => e.status === 502);
});
