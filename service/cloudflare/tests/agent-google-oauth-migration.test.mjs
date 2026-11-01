import assert from "node:assert/strict";
import { test } from "node:test";
import { upgradePreservingRows } from "./migration-preservation.mjs";
import { agentSmtpFixture, agentSmtpInput } from "./agent-smtp-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";

test("0051 adds isolated OAuth tables/view/triggers without altering existing definitions, password bytes, receipts or R2", async () => {
  const f = await agentSmtpFixture({ through: "0050_agent_inbox_automation.sql", resources: { r2Buckets: { INBOX: "agent-google-migration" } } });
  try {
    expect(await f.configure()); const tables = (await f.h.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all()).results;
    const before = new Map(); for (const table of tables) before.set(table.name, (await f.h.db.prepare(`SELECT * FROM "${table.name}" ORDER BY rowid`).all()).results);
    const key = "agent-inbox/v1/preserved/raw.eml", bytes = Uint8Array.from({ length: 524288 }, (_, i) => i % 251);
    await (await f.h.bucket("INBOX")).put(key, bytes); await f.h.migrate("0051_agent_google_oauth.sql"); await f.h.migrate("0051_agent_google_oauth.sql"); await f.h.restart();
    assert.deepEqual(new Uint8Array(await (await (await f.h.bucket("INBOX")).get(key)).arrayBuffer()), bytes);
    for (const table of tables) {
      assert.equal(await f.h.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").bind(table.name).first("sql"), table.sql);
      assert.deepEqual((await f.h.db.prepare(`SELECT * FROM "${table.name}" ORDER BY rowid`).all()).results, before.get(table.name));
    }
    await upgradePreservingRows(f.h, before); await f.h.restart();
    assert.deepEqual(new Uint8Array(await (await (await f.h.bucket("INBOX")).get(key)).arrayBuffer()), bytes);
    const account = expect(await f.h.request(`/api/v1/agent-accounts/${f.id}`, { cookie: f.alice.cookie })).account;
    assert.equal(account.authentication, "password"); assert.equal(account.credentialConfigured, true);
    assert.equal(expect(await f.read()).smtp.authentication, "password");
    expect(await f.configure({ ...agentSmtpInput, smtpRevision: 1 }));
    assert.equal(await f.h.db.prepare("SELECT COUNT(*) n FROM agent_google_oauth_bindings").first("n"), 0);
    await assert.rejects(f.h.db.prepare("INSERT INTO agent_google_oauth_bindings(account_id,user_id) VALUES(?,?)").bind(f.id, f.bob.id).run(), /FOREIGN KEY/);
    assert.deepEqual((await f.h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await f.close(); }
});
