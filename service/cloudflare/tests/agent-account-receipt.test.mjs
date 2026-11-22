import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const bundle = await build({ entryPoints: [fileURLToPath(new URL("../web/agent-accounts-api.ts", import.meta.url))], bundle: true, write: false, format: "esm", platform: "browser" });
const { readAgentAccountReceipt, readAgentAccountTest } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`);
test("Agent account receipts validate original account/key/method/revision and deletion before releasing uncertainty", () => {
  const attempt = { id: crypto.randomUUID(), key: crypto.randomUUID(), method: "PUT", body: { expectedRevision: 7 }, uncertain: true };
  const good = { accountId: attempt.id, requestKey: attempt.key, kind: "PUT", revision: 8, deleted: false, completedAt: 1793356800 };
  assert.deepEqual(readAgentAccountReceipt({ operation: good }, attempt), good);
  for (const value of [null, [], {}, { operation: [] }, { operation: {} }, ...[
    { accountId: crypto.randomUUID() }, { requestKey: crypto.randomUUID() }, { kind: "DELETE" }, { revision: 9 }, { revision: "8" },
    { completedAt: null }, { completedAt: -1 }, { completedAt: 1.5 }, { deleted: true },
  ].map(patch => ({ operation: { ...good, ...patch } }))]) assert.throws(() => readAgentAccountReceipt(value, attempt), error => error.status === 502);
  const deletion = { ...attempt, method: "DELETE" };
  assert.deepEqual(readAgentAccountReceipt({ operation: { ...good, kind: "DELETE", deleted: true } }, deletion), { ...good, kind: "DELETE", deleted: true });
});

test("Agent test response validates identity, positive UID, bounded count and persistence agreement without trusting arbitrary config fields", () => {
  const expected = { id: crypto.randomUUID(), revision: 7, emailAddress: "agent@example.test", username: "Agent", endpointId: "test", displayName: "Unchanged" };
  const good = { account: { ...expected, scope: "agent", kind: "agent_owned", authentication: "password", enabled: true, credentialConfigured: true,
    testedAt: 1793356800, testError: null, inboxUidValidity: "42", inboxMessages: 99, displayName: "Must not replace" },
    test: { accountRevision: 7, authenticated: true, readOnly: true, capabilities: ["AUTH=PLAIN"], inbox: { path: "INBOX", uidValidity: "42", messages: 99 } } };
  assert.equal(readAgentAccountTest(good, expected).displayName, "Unchanged");
  for (const value of [null, {}, { ...good, account: { ...good.account, id: crypto.randomUUID() } },
    ...[{ revision: 8 }, { scope: "normal" }, { inboxMessages: 98 }, { testedAt: null }, { testError: "failed" }, { username: "Other" }]
      .map(patch => ({ ...good, account: { ...good.account, ...patch } })),
    ...[{ authenticated: false }, { readOnly: false }, { accountRevision: 8 }, { capabilities: [1] },
      { inbox: { path: "INBOX", uidValidity: "0", messages: 99 } }, { inbox: { path: "INBOX", uidValidity: "42", messages: 4294967296 } }]
      .map(patch => ({ ...good, test: { ...good.test, ...patch } }))]) assert.throws(() => readAgentAccountTest(value, expected), error => error.status === 502);
});
