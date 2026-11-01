import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { agentInboxFixture } from "./agent-inbox-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";
import { seedAgentEmptyHistory } from "./agent-capacity-fixture.mjs";

test("48-to-49 only adds a live-capacity partial index, preserving every old row, schema and object across restart", async () => {
  const t = await agentInboxFixture({ through: "0048_agent_followups.sql" });
  try {
    const original = expect(await t.receive()).operation; await seedAgentEmptyHistory(t, original);
    const bucket = await t.h.bucket("INBOX"), key = "agent-inbox/v1/preserve/large.eml";
    const bytes = Uint8Array.from({ length: 2097152 }, (_, i) => i % 251); await bucket.put(key, bytes);
    const tables = (await t.h.db.prepare(`SELECT name,sql FROM sqlite_master WHERE type='table'
      AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name`).all()).results;
    const schema = (await t.h.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name").all()).results;
    const before = new Map();
    for (const table of tables) before.set(table.name, (await t.h.db.prepare(`SELECT * FROM "${table.name}" ORDER BY rowid`).all()).results);
    const objects = (await bucket.list()).objects.map(object => ({ key: object.key, etag: object.etag, size: object.size }));
    await t.h.migrate("0049_agent_inbox_capacity.sql"); await t.h.migrate("0049_agent_inbox_capacity.sql"); await t.h.restart();
    const afterSchema = (await t.h.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name").all()).results;
    assert.deepEqual(afterSchema.filter(row => row.name !== "agent_inbox_live_capacity"), schema);
    assert.equal(afterSchema.length, schema.length + 1);
    for (const table of tables) assert.deepEqual((await t.h.db.prepare(`SELECT * FROM "${table.name}" ORDER BY rowid`).all()).results, before.get(table.name), table.name);
    const persisted = await t.h.bucket("INBOX");
    assert.deepEqual((await persisted.list()).objects.map(object => ({ key: object.key, etag: object.etag, size: object.size })), objects);
    assert.deepEqual(new Uint8Array(await (await persisted.get(key)).arrayBuffer()), bytes);
    const compiled = await build({ entryPoints: [fileURLToPath(new URL("../src/agent-inbox-capacity.ts", import.meta.url))], bundle: true, write: false, format: "esm" });
    const { AGENT_INBOX_CAPACITY, AGENT_LIVE_BATCH } = await import(`data:text/javascript,${encodeURIComponent(compiled.outputFiles[0].text)}`);
    const plan = (await t.h.db.prepare(`EXPLAIN QUERY PLAN SELECT ${AGENT_INBOX_CAPACITY}`).bind(t.id, 1, 1).all()).results;
    assert.match(JSON.stringify(plan), /USING (?:COVERING )?INDEX agent_inbox_live_capacity/);
    assert.equal(await t.h.db.prepare(`SELECT COUNT(*) n FROM agent_inbox_batches WHERE account_id=? AND (${AGENT_LIVE_BATCH})`).bind(t.id).first("n"), 1);
    assert.deepEqual(expect(await t.receipt(original.requestKey)).operation, original);
    assert.equal(expect(await t.receive()).operation.state, "committed"); assert.equal(t.opens.length, 2);
    assert.deepEqual((await t.h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await t.close(); }
});
