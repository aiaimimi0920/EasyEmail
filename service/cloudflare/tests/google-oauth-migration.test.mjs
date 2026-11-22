import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { createHarness } from "./runtime-harness.mjs";
import { normalInput } from "./normal-imap-fixture.mjs";
import { seedLegacyNormalAccount } from "./normal-legacy-fixture.mjs";

test("37-to-38 preserves all legacy columns and ciphertext, adds dormant OAuth defaults and retains password AAD", async () => {
  const keyring = JSON.stringify({ active: "k1", keys: { k1: "c5".repeat(32) } });
  const h = await createHarness({ MAILBOX_KEYRING: keyring }, false, "0037_normal_sync_capacity.sql", null, { r2Buckets: { INBOX: "google-migration-inbox" } });
  try {
    const user = await h.register("google-migration-legacy"), accountId = crypto.randomUUID();
    const cipher = await seedLegacyNormalAccount(h, user.id, accountId, normalInput), key = "legacy/test-object.eml", bytes = "Synthetic old message bytes";
    await (await h.bucket("INBOX")).put(key, bytes);
    const tables = (await h.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all()).results;
    const before = {}; for (const { name } of tables) before[name] = (await h.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()).results;
    await h.migrate(); await h.migrate(); await h.restart();
    for (const { name } of tables) {
      const after = (await h.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()).results; assert.equal(after.length, before[name].length);
      for (const [i, row] of before[name].entries()) assert.deepEqual(Object.fromEntries(Object.keys(row).map(k => [k, after[i][k]])), row, name);
    }
    const row = await h.db.prepare("SELECT * FROM normal_accounts").first();
    assert.equal(row.authentication, "password"); assert.equal(row.oauth_grant_id, null); assert.equal(row.oauth_flow_id, null); assert.equal(row.credential_cipher, cipher);
    assert.equal(await (await (await h.bucket("INBOX")).get(key)).text(), bytes);
    assert.deepEqual((await h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
    for (const table of ["google_oauth_attempts", "google_oauth_grants", "google_oauth_disconnects"]) assert.equal(await h.db.prepare(`SELECT COUNT(*) n FROM ${table}`).first("n"), 0);
    const compiled = await build({ entryPoints: [fileURLToPath(new URL("../src/mailbox-vault.ts", import.meta.url))], bundle: true, write: false, format: "esm" });
    const vault = await import(`data:text/javascript,${encodeURIComponent(compiled.outputFiles[0].text)}`);
    const context = { id: accountId, user_id: user.id, provider_id: "normal-imap-v1", purpose: "ee-normal-account-v1" };
    assert.deepEqual(await vault.decryptCredential({ MAILBOX_KEYRING: keyring }, context, cipher), { token: normalInput.password });
    await assert.rejects(vault.decryptCredential({ MAILBOX_KEYRING: keyring }, { ...context, purpose: "ee-google-grant-v1" }, cipher));
  } finally { await h.close(); }
});
