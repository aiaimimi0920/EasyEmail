import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const bundle = await build({ stdin: { contents: `export { attemptContext,grantContext } from './src/google-oauth-model';
  export { normalContext } from './src/normal-account-store'; export { agentAccountContext } from './src/agent-account-store';
  export { smtpContext } from './src/smtp-config-store'; export { agentSmtpContext } from './src/agent-smtp-store';
  export { sealVault,openVault } from './src/mailbox-vault'; export { readAgentSenderAccount } from './web/agent-sender-options';
  export { readAgentSmtpConfig,readAgentSmtpEndpoints } from './web/agent-smtp-api';`, resolveDir: fileURLToPath(new URL("../", import.meta.url)) },
  bundle: true, write: false, format: "esm", platform: "node" });
const m = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`);
const env = { MAILBOX_KEYRING: JSON.stringify({ active: "k1", keys: { k1: "c5".repeat(32) } }) };

test("normal and Agent AAD domains reject transplanted ciphers even with identical user/account/grant IDs and endpoint metadata", async () => {
  const id = crypto.randomUUID(), user = crypto.randomUUID();
  const grant = { id, user_id: user, account_id: id, endpoint_hash: "same", username: "same", email_address: "same@example.test", config_hash: "same" };
  for (const [left, right] of [[m.attemptContext(id, user), m.attemptContext(id, user, "agent")],
    [m.grantContext(grant), m.grantContext(grant, "agent")], [m.normalContext(id, user), m.agentAccountContext(id, user)],
    [m.smtpContext(id, user), m.agentSmtpContext(id, user)]]) {
    const cipher = await m.sealVault(env, left, { secret: "synthetic-only" });
    assert.deepEqual(await m.openVault(env, left, cipher), { secret: "synthetic-only" });
    await assert.rejects(m.openVault(env, right, cipher));
    const inverse = await m.sealVault(env, right, { secret: "synthetic-only" }); await assert.rejects(m.openVault(env, left, inverse));
  }
});

test("Agent DTOs admit explicit Google authorization but reject scope changes, unknown mechanisms and mixed SMTP metadata", () => {
  const account = { id: crypto.randomUUID(), scope: "agent", kind: "agent_owned", authentication: "google-oauth2", revision: 2,
    emailAddress: "alice@example.test", username: "alice@example.test", displayName: "Agent", endpointId: "google", enabled: true, credentialConfigured: true };
  assert.deepEqual(m.readAgentSenderAccount(account), account);
  for (const patch of [{ scope: "normal" }, { authentication: "oauth" }, { kind: "normal" }]) assert.throws(() => m.readAgentSenderAccount({ ...account, ...patch }));
  const smtp = { accountId: account.id, scope: "agent", authentication: "google-oauth2", parentRevision: 2, accountRevision: 2, revision: 1,
    endpointId: "google", username: account.username, enabled: true, credentialConfigured: true, current: true, updatedAt: 100 };
  assert.deepEqual(m.readAgentSmtpConfig({ smtp }, account), smtp);
  assert.throws(() => m.readAgentSmtpConfig({ smtp: { ...smtp, authentication: "password" } }, account));
  const endpoint = { id: "google", label: "Google", hostname: "smtp.gmail.com", port: 465, security: "tls", authentication: "google-oauth2" };
  assert.deepEqual(m.readAgentSmtpEndpoints({ items: [endpoint] }), [endpoint]);
  const starttls = { ...endpoint, port: 587, security: "starttls" }; assert.deepEqual(m.readAgentSmtpEndpoints({ items: [starttls] }), [starttls]);
  for (const patch of [{ hostname: "evil.example.test" }, { port: 465, security: "starttls" }, { authentication: "oauth" }])
    assert.throws(() => m.readAgentSmtpEndpoints({ items: [{ ...endpoint, ...patch }] }));
});
