import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { agentBindings, expect } from "./agent-accounts-fixture.mjs";
import { agentSmtpFixture, agentSmtpInput } from "./agent-smtp-fixture.mjs";

const bundle = await build({ stdin: { contents: `export { agentSmtpContext } from './agent-smtp-store'; export { smtpContext } from './smtp-config-store';
export { agentAccountContext } from './agent-account-store'; export { normalContext } from './normal-account-store';
export { encryptCredential, decryptCredential } from './mailbox-vault';`, resolveDir: fileURLToPath(new URL("../src/", import.meta.url)) },
  bundle: true, write: false, format: "esm", platform: "node" });
const vault = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`);

test("Agent SMTP vault binds actual user/account/AAD and cannot exchange ciphertext with Agent IMAP or either normal credential purpose", async () => {
  const id = crypto.randomUUID(), user = crypto.randomUUID(), contexts = ["agentSmtpContext", "smtpContext", "agentAccountContext", "normalContext"].map(name => vault[name](id, user));
  for (const context of contexts) {
    const secret = { token: "private-synthetic-password" }, cipher = await vault.encryptCredential(agentBindings, context, secret);
    assert.deepEqual(await vault.decryptCredential(agentBindings, context, cipher), secret);
    for (const other of [...contexts.filter(c => c !== context), { ...context, id: crypto.randomUUID() }, { ...context, user_id: crypto.randomUUID() }])
      await assert.rejects(vault.decryptCredential(agentBindings, other, cipher), error => error.code === "mailbox_credential_unavailable");
  }
});

test("Agent SMTP HMAC replay survives supported rotation, fails closed without the original key and leaves metadata readable", async () => {
  const t = await agentSmtpFixture(), { h, alice } = t;
  try {
    const key = crypto.randomUUID(), original = expect(await t.configure(agentSmtpInput, key));
    const before = await h.db.prepare("SELECT * FROM agent_smtp_configs").first();
    await h.restart({ MAILBOX_KEYRING: JSON.stringify({ active: "k2", keys: { k1: "c5".repeat(32), k2: "d6".repeat(32) } }) });
    assert.deepEqual(expect(await t.configure(agentSmtpInput, key)).operation, original.operation);
    await h.restart({ MAILBOX_KEYRING: JSON.stringify({ active: "k2", keys: { k2: "d6".repeat(32) } }) });
    expect(await t.configure(agentSmtpInput, key), 503);
    assert.deepEqual(await h.db.prepare("SELECT * FROM agent_smtp_configs").first(), before);
    expect(await h.request(`/api/v1/agent-smtp-operations/${key}`, { cookie: alice.cookie }));
    expect(await t.configure({ ...agentSmtpInput, smtpRevision: 1 }));
    assert.equal(JSON.parse(await h.db.prepare("SELECT credential_cipher FROM agent_smtp_configs").first("credential_cipher")).key, "k2");
  } finally { await t.close(); }
});
