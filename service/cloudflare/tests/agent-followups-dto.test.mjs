import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const source = new URL("../web/agent-followups-api.ts", import.meta.url);
const result = await build({ entryPoints: [fileURLToPath(source)], bundle: true, platform: "node", format: "esm", write: false });
const { readAgentFollowup, readAgentFollowupPage, readAgentFollowupContext } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const thread = { id: id(1), kind: "inbound", management: { state: "open", revision: 1 }, inbound: { accountId: id(2), serviceId: id(3) } };
const body = { senderAccountId: id(2), serviceId: id(3), accountRevision: 1, smtpRevision: 2, serviceVersion: 3, expectedThreadRevision: 1,
  replyToType: "incoming", replyToId: id(4), confirmRestricted: true, confirmUncertain: true, subject: "合成跟进", text: "原正文" };
const attempt = { key: id(5), threadId: thread.id, threadKind: thread.kind, body, from: "me@example.test", to: "agent@example.test" };
const row = { ...body, id: id(6), requestKey: attempt.key, threadId: thread.id, threadKind: thread.kind, threadRevision: 1,
  from: attempt.from, to: attempt.to, messageId: `<${id(6)}@easyemail.invalid>`, inReplyTo: "<incoming@example.test>", state: "queued", error: null,
  revision: 1, cancellable: true, retrySafe: false, delivery: "unconfirmed", attempts: 0, nextAttemptAt: 1, deadlineAt: 2, createdAt: 1, updatedAt: 1, contentPurgedAt: null };
delete row.expectedThreadRevision;
const invalid = value => assert.throws(() => readAgentFollowup({ followup: value }, attempt), /agent_followup_response_invalid/);
test("follow-up receipts bind every original intent field, root kind, actual addresses and original key before releasing uncertainty", () => {
  assert.deepEqual(readAgentFollowup({ followup: row }, attempt), row);
  for (const [key, value] of Object.entries({ requestKey: id(9), threadId: id(9), threadKind: "task", senderAccountId: id(9), serviceId: id(9),
    accountRevision: 4, smtpRevision: 4, serviceVersion: 4, threadRevision: 4, replyToType: "task", replyToId: id(9), confirmRestricted: false,
    confirmUncertain: false, subject: "其他", text: "其他", from: "other@example.test", to: "other@example.test" })) invalid({ ...row, [key]: value });
  for (const value of [{}, { ...row, messageId: "<foreign@example.test>" }, { ...row, retrySafe: true }, { ...row, delivery: "delivered" },
    { ...row, cancellable: false }, { ...row, state: "new-state" }, { ...row, revision: 0 }, { ...row, inReplyTo: "\r\nInjected" }]) invalid(value);
});
test("purged terminal receipts retain original intent identity without fabricating unavailable content", () => {
  const purged = { ...row, state: "unknown", cancellable: false, contentPurgedAt: 4, subject: "", text: "", from: "", to: "" };
  assert.deepEqual(readAgentFollowup({ followup: purged }, attempt), purged);
  for (const value of [{ ...purged, text: "leak" }, { ...purged, subject: "leak" }, { ...purged, from: attempt.from },
    { ...purged, state: "pending" }, { ...purged, threadRevision: 5 }]) invalid(value);
});
test("follow-up context matches the displayed root and management revision but accepts same-address source version rotation", () => {
  const context = { threadId: thread.id, threadKind: thread.kind, threadRevision: 1, threadState: "open", senderAccountId: id(2), serviceId: id(3),
    accountRevision: 9, smtpRevision: 10, serviceVersion: 8, from: attempt.from, to: attempt.to, trustLevel: "unknown", uncertain: false };
  assert.deepEqual(readAgentFollowupContext({ context }, thread), context);
  for (const fields of [{ threadId: id(9) }, { threadKind: "task" }, { threadRevision: 2 }, { threadState: "archived" },
    { senderAccountId: id(9) }, { serviceId: id(9) }, { smtpRevision: -1 }, { from: "" }, { to: "bad\n@example.test" }, { uncertain: 0 }]) {
    assert.throws(() => readAgentFollowupContext({ context: { ...context, ...fields } }, thread), /agent_followup_response_invalid/);
  }
});
test("follow-up metadata pages enforce same-root kind, bounded strictly increasing IDs, cursor identity and absence of private detail", () => {
  const { text, from, to, ...summary } = row;
  assert.equal(readAgentFollowupPage({ items: [summary], nextCursor: null }, thread).items.length, 1);
  for (const value of [{ items: [row], nextCursor: null }, { items: [summary, summary], nextCursor: null },
    { items: [{ ...summary, threadKind: "task" }], nextCursor: null }, { items: [{ ...summary, threadId: id(9) }], nextCursor: null },
    { items: [summary], nextCursor: id(9) }, { items: [], nextCursor: summary.id }, { items: Array(21).fill(summary), nextCursor: null }]) {
    assert.throws(() => readAgentFollowupPage(value, thread), /agent_followup_response_invalid/);
  }
  assert.throws(() => readAgentFollowupPage({ items: [summary], nextCursor: null }, thread, summary.id), /agent_followup_response_invalid/);
});
