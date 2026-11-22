import assert from "node:assert/strict";
import { test } from "node:test";
import { upgradePreservingRows } from "./migration-preservation.mjs";
import { newKey, seedMailbox } from "./runtime-harness.mjs";
import { agentAccountsFixture, agentWrite, agentAccountInput, expect } from "./agent-accounts-fixture.mjs";

test("0040 expands only: previous normal/temporary/service schemas, records and credentials survive and Agent data persists on restart", async () => {
  const t = await agentAccountsFixture({}, null, "0039_agent_services.sql"), { h, alice } = t;
  try {
    const key = await newKey(h, alice.cookie, { scopes: ["mailboxes:read", "mail-accounts:read", "agent-services:read"] });
    const mailboxId = await seedMailbox(h, alice.id, "before-agent-account@example.test");
    expect(await h.request(`/api/v1/normal-accounts/${crypto.randomUUID()}`, { cookie: alice.cookie, method: "PUT", body: agentAccountInput,
      headers: { "idempotency-key": crypto.randomUUID() } }), 201);
    expect(await h.request("/api/v1/agent-services", { cookie: alice.cookie, method: "POST", body: { displayName: "Existing service", emailAddress: "service@example.test" },
      headers: { "idempotency-key": crypto.randomUUID() } }), 201);
    const tables = (await h.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all()).results;
    const rows = new Map(), snapshot = async table => (await h.db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()).results;
    for (const table of tables) rows.set(table.name, await snapshot(table.name));
    await h.migrate("0040_agent_accounts.sql"); await h.migrate("0040_agent_accounts.sql");
    for (const table of tables) {
      assert.equal(await h.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").bind(table.name).first("sql"), table.sql);
      assert.deepEqual(await snapshot(table.name), rows.get(table.name), table.name);
    }
    await upgradePreservingRows(h, rows);
    expect(await h.request(`/api/v1/mailboxes/${mailboxId}`, { token: key.token }));
    expect(await h.request("/api/v1/agent-accounts", { token: key.token }), 403);
    const id = crypto.randomUUID(); expect(await agentWrite(h, alice, id), 201);
    const saved = expect(await h.request(`/api/v1/agent-accounts/${id}`, { cookie: alice.cookie }));
    await h.restart(); assert.deepEqual(expect(await h.request(`/api/v1/agent-accounts/${id}`, { cookie: alice.cookie })), saved);
    const sql = await h.db.prepare("SELECT sql FROM sqlite_master WHERE name='agent_account_operations'").first("sql");
    assert.equal(/email_address|username|credential_cipher|password/.test(sql), false);
  } finally { await t.close(); }
});
