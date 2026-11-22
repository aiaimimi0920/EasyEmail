import assert from "node:assert/strict";
import { test } from "node:test";
import { upgradePreservingRows } from "./migration-preservation.mjs";
import { newKey, seedMailbox } from "./runtime-harness.mjs";
import { agentServicesFixture, createService, getService, expect } from "./agent-services-fixture.mjs";

test("0039 is expand-only: old schemas, bytes, keys and ownership stay unchanged; directory persists across restart", async () => {
  const f = await agentServicesFixture({}, false, "0038_google_oauth.sql"); const { h, alice } = f;
  try {
    const oldKey = await newKey(h, alice.cookie, { scopes: ["mailboxes:read", "contacts:read", "mail-accounts:read"] });
    const mailboxId = await seedMailbox(h, alice.id, "before-agent@example.test");
    const tables = (await h.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all()).results;
    const snapshot = async table => (await h.db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()).results;
    const rows = new Map(); for (const table of tables) rows.set(table.name, await snapshot(table.name));
    await h.migrate("0039_agent_services.sql"); await h.migrate("0039_agent_services.sql");
    for (const table of tables) {
      assert.equal(await h.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").bind(table.name).first("sql"), table.sql, table.name);
      assert.deepEqual(await snapshot(table.name), rows.get(table.name), table.name);
    }
    await upgradePreservingRows(h, rows);
    expect(await h.request(`/api/v1/mailboxes/${mailboxId}`, { token: oldKey.token }));
    expect(await h.request("/api/v1/agent-services", { token: oldKey.token }), 403);
    const saved = expect(await createService(h, alice), 201), service = expect(await getService(h, alice, saved.operation.serviceId)).service;
    await h.restart(); assert.deepEqual(expect(await getService(h, alice, service.id)).service, service);
    const schema = await h.db.prepare("SELECT sql FROM sqlite_master WHERE name='agent_service_operations'").first("sql");
    assert.equal(/email_address|description|display_name|parsed_payload/.test(schema), false);
  } finally { await f.close(); }
});
