import assert from "node:assert/strict";
import { test } from "node:test";
import { upgradePreservingRows } from "./migration-preservation.mjs";
import { newKey } from "./runtime-harness.mjs";
import { expect } from "./agent-accounts-fixture.mjs";
import { agentSmtpFixture } from "./agent-smtp-fixture.mjs";

test("0041 expands only, preserves all existing rows and retires Agent SMTP even through an older account writer", async () => {
  const t = await agentSmtpFixture({ through: "0040_agent_accounts.sql" }), { h, alice, id } = t;
  try {
    const key = await newKey(h, alice.cookie, { scopes: ["agent-accounts:read"] });
    const tables = (await h.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all()).results;
    const rows = new Map(), snapshot = async table => (await h.db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()).results;
    for (const table of tables) rows.set(table.name, await snapshot(table.name));
    await h.migrate("0041_agent_smtp.sql"); await h.migrate("0041_agent_smtp.sql");
    for (const table of tables) {
      assert.equal(await h.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").bind(table.name).first("sql"), table.sql);
      assert.deepEqual(await snapshot(table.name), rows.get(table.name), table.name);
    }
    await upgradePreservingRows(h, rows);
    expect(await h.request(t.route, { token: key.token })); expect(await t.configure());
    const saved = expect(await t.read()); await h.restart(); assert.deepEqual(expect(await t.read()), saved);
    // W11b account writers update only the parent row: schema-owned retirement must still run.
    await h.db.prepare("UPDATE agent_accounts SET enabled=0,credential_cipher=NULL,revision=revision+1,updated_at=unixepoch() WHERE id=?").bind(id).run();
    let row = await h.db.prepare("SELECT * FROM agent_smtp_configs WHERE account_id=?").bind(id).first();
    assert.equal(row.credential_cipher, null); assert.equal(row.enabled, 0); assert.equal(row.username, ""); assert.equal(row.revision, 2);
    const completed = await snapshot("agent_smtp_operations");
    await h.db.prepare("UPDATE agent_accounts SET deleted_at=unixepoch(),revision=revision+1 WHERE id=?").bind(id).run();
    row = await h.db.prepare("SELECT * FROM agent_smtp_configs WHERE account_id=?").bind(id).first(); assert.equal(row.revision, 2);
    assert.deepEqual(await snapshot("agent_smtp_operations"), completed);
    await assert.rejects(h.db.prepare("INSERT INTO agent_smtp_configs(account_id,user_id,account_revision,revision,endpoint_id,endpoint_hash,username,enabled,updated_at) VALUES(?,?,1,1,'x','x','x',0,0)")
      .bind(crypto.randomUUID(), alice.id).run(), /FOREIGN KEY/);
    await assert.rejects(h.db.prepare("UPDATE agent_smtp_configs SET user_id=? WHERE account_id=?").bind(t.bob.id, id).run(), /FOREIGN KEY/);
    await assert.rejects(h.db.prepare(`INSERT INTO agent_smtp_operations(user_id,request_key,id,account_id,request_hash,account_revision,revision,created_at,completed_at)
      VALUES(?,?,?,?,'synthetic',1,1,1,1)`).bind(t.bob.id, crypto.randomUUID(), crypto.randomUUID(), id).run(), /FOREIGN KEY/);
    const sql = await h.db.prepare("SELECT sql FROM sqlite_master WHERE name='agent_smtp_operations'").first("sql");
    assert.equal(/username|credential_cipher|password/.test(sql), false);
  } finally { await t.close(); }
});
