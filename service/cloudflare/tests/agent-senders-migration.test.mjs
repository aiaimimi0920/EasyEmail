import assert from "node:assert/strict";
import { test } from "node:test";
import { upgradePreservingRows } from "./migration-preservation.mjs";
import { createHash } from "node:crypto";
import { agentSmtpFixture } from "./agent-smtp-fixture.mjs";
import { getService, serviceWrite, expect } from "./agent-services-fixture.mjs";

test("0044 is additive, preserves legacy operation hashes and leaves old-runtime service deletion safe", async () => {
  const t = await agentSmtpFixture({ through: "0043_agent_inbox.sql" }), { h, alice, bob } = t;
  try {
    const id = crypto.randomUUID(), key = crypto.randomUUID(), command = { kind: "POST", targetId: null,
      fields: { displayName: "legacy service", emailAddress: "legacy-default@example.test", description: null, serviceKind: "email_agent", trustLevel: "unknown", status: "active" } };
    const hash = createHash("sha256").update(JSON.stringify(command)).digest("hex");
    await h.db.prepare(`INSERT INTO agent_services(user_id,id,display_name,email_address,service_kind,trust_level,status,version,created_at,updated_at)
      VALUES(?,?,?,?,'email_agent','unknown','active',1,unixepoch(),unixepoch())`).bind(alice.id, id, command.fields.displayName, command.fields.emailAddress).run();
    await h.db.prepare(`INSERT INTO agent_service_operations(user_id,request_key,id,request_hash,kind,service_id,version,created_at,completed_at)
      VALUES(?,?,?,?,'POST',?,1,unixepoch(),unixepoch())`).bind(alice.id, key, crypto.randomUUID(), hash, id).run();
    const tables = (await h.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all()).results;
    const snapshots = new Map(); for (const table of tables) snapshots.set(table.name, (await h.db.prepare(`SELECT * FROM "${table.name}" ORDER BY rowid`).all()).results);
    await h.migrate("0044_agent_service_senders.sql"); await h.migrate("0044_agent_service_senders.sql");
    for (const table of tables) {
      assert.equal(await h.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").bind(table.name).first("sql"), table.sql);
      assert.deepEqual((await h.db.prepare(`SELECT * FROM "${table.name}" ORDER BY rowid`).all()).results, snapshots.get(table.name), table.name);
    }
    await upgradePreservingRows(h, snapshots);
    const replay = expect(await serviceWrite(h, alice, "POST", null, { displayName: command.fields.displayName, emailAddress: command.fields.emailAddress }, key));
    assert.equal(replay.replayed, true); assert.equal(replay.operation.serviceId, id);
    expect(await serviceWrite(h, alice, "PATCH", id, { expectedVersion: 1, defaultSenderAccountId: t.id }));
    await assert.rejects(h.db.prepare("UPDATE agent_service_senders SET user_id=? WHERE service_id=?").bind(bob.id, id).run(), /FOREIGN KEY/);
    await assert.rejects(h.db.prepare("UPDATE agent_accounts SET user_id=? WHERE id=?").bind(bob.id, t.id).run(), /FOREIGN KEY/);
    await h.restart(); assert.equal(expect(await getService(h, alice, id)).service.defaultSenderAccountId, t.id);
    await h.db.prepare("UPDATE agent_services SET version=version+1,description='legacy runtime edit' WHERE user_id=? AND id=?").bind(alice.id, id).run();
    assert.equal(expect(await getService(h, alice, id)).service.defaultSenderAccountId, t.id);
    await h.db.prepare("UPDATE agent_services SET version=version+1,deleted_at=unixepoch() WHERE user_id=? AND id=?").bind(alice.id, id).run();
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM agent_service_senders WHERE service_id=?").bind(id).first("n"), 0);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM agent_accounts WHERE id=?").bind(t.id).first("n"), 1);
  } finally { await t.close(); }
});
