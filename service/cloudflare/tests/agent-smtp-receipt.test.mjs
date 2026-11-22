import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const bundle = await build({ entryPoints: [fileURLToPath(new URL("../web/agent-smtp-api.ts", import.meta.url))], bundle: true, write: false, format: "esm", platform: "browser" });
const { readAgentSmtpReceipt, readAgentSmtpConfig } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`);
test("Agent SMTP completion binds original account/key/method and both versions before clearing uncertainty", () => {
  const attempt = { id: crypto.randomUUID(), key: crypto.randomUUID(), body: { expectedRevision: 7, smtpRevision: 2 } };
  const good = { accountId: attempt.id, requestKey: attempt.key, kind: "PUT", accountRevision: 7, revision: 3, completedAt: 1793356800 };
  assert.deepEqual(readAgentSmtpReceipt({ operation: good }, attempt), good);
  for (const value of [null, [], {}, { operation: {} }, ...[{ accountId: crypto.randomUUID() }, { requestKey: crypto.randomUUID() },
    { kind: "DELETE" }, { accountRevision: 8 }, { revision: 4 }, { revision: "3" }, { completedAt: null }, { completedAt: -1 }]
    .map(patch => ({ operation: { ...good, ...patch } }))]) assert.throws(() => readAgentSmtpReceipt(value, attempt), e => e.status === 502);
});

test("Agent SMTP config reads validate target, parent/current agreement and credential flags without trusting malformed success", () => {
  const account = { id: crypto.randomUUID(), revision: 7 };
  const good = { accountId: account.id, scope: "agent", authentication: "password", parentRevision: 7, accountRevision: 7, revision: 2,
    endpointId: "smtp", username: "Agent", enabled: true, credentialConfigured: true, current: true, updatedAt: 1793356800 };
  assert.deepEqual(readAgentSmtpConfig({ smtp: good }, account), good);
  assert.equal(readAgentSmtpConfig({ smtp: { ...good, accountRevision: 6, current: false } }, account).current, false);
  for (const value of [null, {}, { smtp: {} }, ...[{ accountId: crypto.randomUUID() }, { scope: "normal" }, { authentication: "google-oauth2" },
    { parentRevision: 8 }, { accountRevision: 0 }, { revision: -1 }, { username: 42 }, { enabled: "true" }, { credentialConfigured: false },
    { current: false }, { updatedAt: null }].map(patch => ({ smtp: { ...good, ...patch } }))]) assert.throws(() => readAgentSmtpConfig(value, account), e => e.status === 502 || e.status === 409);
});
