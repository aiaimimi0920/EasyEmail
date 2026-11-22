import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const bundle = await build({ entryPoints: [fileURLToPath(new URL("../web/agent-inbox-api.ts", import.meta.url))], bundle: true, write: false, format: "esm", platform: "browser" });
const { readAgentInboxOperation, readAgentIncoming } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`);
const reviewBundle = await build({ entryPoints: [fileURLToPath(new URL("../web/agent-review-api.ts", import.meta.url))], bundle: true, write: false, format: "esm", platform: "browser" });
const { readAgentReview, readAgentReviewOperation } = await import(`data:text/javascript;base64,${Buffer.from(reviewBundle.outputFiles[0].contents).toString("base64")}`);
test("Agent inbox receipts bind original key/account/revision and validate results before releasing uncertain intent", () => {
  const attempt = { key: crypto.randomUUID(), accountId: crypto.randomUUID(), revision: 2 }, operation = { id: crypto.randomUUID(), requestKey: attempt.key,
    accountId: attempt.accountId, accountRevision: 2, state: "committed", createdAt: 100, finishedAt: 101, errorCode: null,
    result: { batchId: crypto.randomUUID(), accountRevision: 2, epochId: crypto.randomUUID(), stored: 2, skipped: [], reset: false, complete: true, cursor: { uidValidity: "42", afterUid: 7 } } };
  assert.deepEqual(readAgentInboxOperation({ operation }, attempt), operation);
  for (const patch of [{ requestKey: crypto.randomUUID() }, { accountId: crypto.randomUUID() }, { accountRevision: 3 }, { state: "done" }, { result: null },
    { finishedAt: null }, { errorCode: "failed" }, { result: { ...operation.result, stored: 99 } }, { result: { ...operation.result, accountRevision: 3 } }])
    assert.throws(() => readAgentInboxOperation({ operation: { ...operation, ...patch } }, attempt), e => e.status === 502);
  assert.throws(() => readAgentInboxOperation({}, attempt), e => e.status === 502);
});
test("incoming detail cannot claim verified identity, arbitrary task IDs or unbounded content", () => {
  const message = { id: crypto.randomUUID(), accountId: crypto.randomUUID(), epochId: crypto.randomUUID(), uid: 1, subject: "reply", sender: "agent@example.test",
    recipient: "alice@example.test", receivedAt: 100, observedAt: 101, association: "linked", threadId: crypto.randomUUID(), serviceId: crypto.randomUUID(), authentication: "unverified",
    content: { textBody: "body", htmlBody: "", attachments: [], attachmentsTruncated: false } };
  message.review = { revision: 0, state: "unreviewed", threadId: null, effectiveThreadId: message.threadId, needsAttention: false, updatedAt: null };
  assert.deepEqual(readAgentIncoming({ message }, message.accountId, message.id), message);
  for (const patch of [{ authentication: "verified" }, { threadId: null }, { association: "unmatched" }, { content: null }, { accountId: crypto.randomUUID() },
    { content: { ...message.content, textBody: "x".repeat(131073) } }])
    assert.throws(() => readAgentIncoming({ message: { ...message, ...patch } }, message.accountId, message.id), e => e.status === 502);
});

test("manual view rejects forged states, revisions, attention or effective-thread evidence instead of trusting a successful HTTP status", () => {
  const original = crypto.randomUUID(), target = crypto.randomUUID();
  const initial = { revision: 0, state: "unreviewed", threadId: null, effectiveThreadId: original, needsAttention: false, updatedAt: null };
  assert.deepEqual(readAgentReview(initial, "linked", original), initial);
  const linked = { revision: 1, state: "linked", threadId: target, effectiveThreadId: target, needsAttention: false, updatedAt: 101 };
  assert.deepEqual(readAgentReview(linked, "linked", original), linked);
  for (const patch of [{ state: ["linked"] }, { state: "trusted" }, { revision: 0 }, { revision: -1 }, { threadId: null }, { effectiveThreadId: original }, { needsAttention: true }, { updatedAt: null }])
    assert.throws(() => readAgentReview({ ...linked, ...patch }, "linked", original), e => e.status === 502);
  assert.throws(() => readAgentReview(undefined, "linked", original), e => e.status === 502);
  assert.throws(() => readAgentReview({ ...initial, needsAttention: true }, "linked", original), e => e.status === 502);
});

test("manual completion receipts bind the exact original account, message, body, target and next revision", () => {
  const attempt = { key: crypto.randomUUID(), accountId: crypto.randomUUID(), messageId: crypto.randomUUID(), uncertain: true,
    body: { accountRevision: 2, epochId: crypto.randomUUID(), expectedRevision: 5, state: "linked", threadId: crypto.randomUUID() } };
  const operation = { requestKey: attempt.key, accountId: attempt.accountId, messageId: attempt.messageId, ...attempt.body, revision: 6, completedAt: 101 };
  assert.deepEqual(readAgentReviewOperation({ operation }, attempt), operation);
  for (const patch of [{ requestKey: crypto.randomUUID() }, { accountId: crypto.randomUUID() }, { messageId: crypto.randomUUID() }, { accountRevision: 3 },
    { epochId: crypto.randomUUID() }, { state: "dismissed" }, { threadId: crypto.randomUUID() }, { revision: 5 }, { revision: "6" }, { completedAt: null }])
    assert.throws(() => readAgentReviewOperation({ operation: { ...operation, ...patch } }, attempt), e => e.status === 502);
});
