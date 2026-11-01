import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const compiled = await build({ entryPoints: [fileURLToPath(new URL("../web/agent-auto-inbox-api.ts", import.meta.url))], bundle: true, write: false, format: "esm", platform: "browser" });
const { readAutoInboxConfig, readAutoInboxReceipt } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString("base64")}`);
test("automatic config receipts bind every original command field and original key before uncertainty is released", () => {
  const attempt = { accountId: crypto.randomUUID(), key: crypto.randomUUID(), body: { expectedAccountRevision: 3, expectedRevision: 2, enabled: true, intervalMinutes: 5, persistentAuthorization: true } };
  const operation = { id: crypto.randomUUID(), accountId: attempt.accountId, requestKey: attempt.key, accountRevision: 3, expectedRevision: 2, revision: 3, enabled: true, intervalMinutes: 5, persistentAuthorization: true, completedAt: 10 };
  assert.deepEqual(readAutoInboxReceipt({ operation }, attempt), operation);
  for (const patch of [{ id: "invalid" }, { accountId: crypto.randomUUID() }, { requestKey: crypto.randomUUID() }, { accountRevision: 4 }, { expectedRevision: 1 },
    { revision: 4 }, { enabled: false }, { intervalMinutes: 15 }, { persistentAuthorization: false }, { completedAt: null }])
    assert.throws(() => readAutoInboxReceipt({ operation: { ...operation, ...patch } }, attempt), error => error.status === 502);
});
test("automatic config DTO rejects forged binding, state, versions and unbounded error metadata", () => {
  const account = { id: crypto.randomUUID(), revision: 3 }, config = { accountId: account.id, accountRevision: 3, revision: 1, boundAccountRevision: 3,
    enabled: true, intervalMinutes: 5, ready: true, nextDueAt: 20, lastState: "idle", lastErrorCode: null, lastRequestKey: null, lastStartedAt: null, lastFinishedAt: null };
  assert.deepEqual(readAutoInboxConfig({ config }, account), config);
  for (const patch of [{ accountId: crypto.randomUUID() }, { accountRevision: 2 }, { revision: "1" }, { revision: -1 }, { boundAccountRevision: 1 },
    { enabled: false }, { intervalMinutes: 1 }, { lastState: ["idle"] }, { lastState: "sent" }, { lastRequestKey: "invalid" }, { lastErrorCode: "x".repeat(257) }, { nextDueAt: -1 }])
    assert.throws(() => readAutoInboxConfig({ config: { ...config, ...patch } }, account), error => error.status === 502);
});
