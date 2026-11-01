import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const bundle = await build({ entryPoints: [fileURLToPath(new URL("../web/agent-threads-api.ts", import.meta.url))], bundle: true, write: false, format: "esm", platform: "browser" });
const { readAgentThread, readAgentThreadPage, readAgentThreadOperation } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`);
const invalid = fn => assert.throws(fn, error => error.status === 502);
function sample() {
  const id = crypto.randomUUID(), outgoingId = crypto.randomUUID();
  return { id, kind: "task", management: { state: "open", revision: 0, manual: false, updatedAt: null }, task: {
    id, requestKey: crypto.randomUUID(), serviceId: crypto.randomUUID(), serviceVersion: 1, senderAccountId: crypto.randomUUID(), accountRevision: 1, smtpRevision: 1,
    outgoingId, messageId: `<${outgoingId}@easyemail.invalid>`, state: "queued", threadState: "draft", error: null, revision: 1, subject: "任务", text: "正文",
    from: "from@example.test", to: "to@example.test", confirmRestricted: false, cancellable: true, retrySafe: false, delivery: "unconfirmed", attempts: 0,
    nextAttemptAt: 1, deadlineAt: 86401, createdAt: 1, updatedAt: 1, contentPurgedAt: null,
  } };
}
test("thread DTO keeps manual revision separate and never promotes mismatched or automatic completion", () => {
  const thread = sample(); assert.deepEqual(readAgentThread({ thread }), thread);
  for (const patch of [{ revision: 1 }, { state: "completed" }, { manual: true }, { updatedAt: 2 }, { state: "sent" }, { revision: -1 }, { revision: 0.1 }]) {
    invalid(() => readAgentThread({ thread: { ...thread, management: { ...thread.management, ...patch } } }));
  }
  invalid(() => readAgentThread({ thread: { ...thread, id: crypto.randomUUID() } }));
  invalid(() => readAgentThread({ thread: { ...thread, kind: "incoming" } }));
  const manual = { ...thread, management: { state: "completed", revision: 2, manual: true, updatedAt: 100 } };
  assert.deepEqual(readAgentThread({ thread: manual }), manual); assert.equal(manual.task.revision, 1);
});
test("thread pages validate ordering, filter, original cursor and nested task contract", () => {
  const items = [sample(), sample()].sort((a, b) => a.id.localeCompare(b.id)), value = { items, nextCursor: `${items[1].id}.open` };
  assert.deepEqual(readAgentThreadPage(value, "open"), value);
  for (const altered of [{ ...value, items: [items[1], items[0]] }, { ...value, items: [items[0], items[0]] },
    { ...value, nextCursor: `${items[0].id}.open` }, { ...value, nextCursor: `${items[1].id}.all` }, { ...value, items: [] }, {}]) invalid(() => readAgentThreadPage(altered, "open"));
  invalid(() => readAgentThreadPage(value, "completed")); invalid(() => readAgentThreadPage(value, "open", `${items[0].id}.open`));
});
test("thread receipts bind the whole original body, key and thread rather than a generic success flag", () => {
  const attempt = { key: crypto.randomUUID(), threadId: crypto.randomUUID(), body: { expectedRevision: 3, state: "archived" } };
  const operation = { requestKey: attempt.key, threadId: attempt.threadId, state: "archived", revision: 4, completedAt: 100 };
  assert.deepEqual(readAgentThreadOperation({ operation }, attempt), operation);
  for (const patch of [{ requestKey: crypto.randomUUID() }, { threadId: crypto.randomUUID() }, { state: "open" }, { revision: 3 }, { completedAt: null }, { completedAt: -1 }]) {
    invalid(() => readAgentThreadOperation({ operation: { ...operation, ...patch } }, attempt));
  }
  invalid(() => readAgentThreadOperation({}, attempt));
});
