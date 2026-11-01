import assert from "node:assert/strict";
import { test } from "node:test";
import { agentFollowupsFixture } from "./agent-followups-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";

async function cloneFollowups(t, id, count, state) {
  const columns = (await t.h.db.prepare("PRAGMA table_info(agent_followups)").all()).results.map(row => row.name);
  const expressions = columns.map(name => ({ id: "lower(hex(randomblob(16)))", request_key: "lower(hex(randomblob(16)))",
    rfc_message_id: "'<'||lower(hex(randomblob(16)))||'@example.test>'", state: `'${state}'` })[name] ?? `f.${name}`);
  await t.h.db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?)
    INSERT INTO agent_followups(${columns.join(",")}) SELECT ${expressions.join(",")} FROM agent_followups f,n WHERE f.id=?`)
    .bind(count, id).run();
}

test("mixed queue capacity is enforced against legacy task writers and complete transaction rollback preserves the old root count", async () => {
  const t = await agentFollowupsFixture();
  try {
    const task = expect(await t.enqueue(), 201).task; await t.run(); const input = await t.followupInput(task.id);
    const first = expect(await t.followup(task.id, input), 201).followup; await cloneFollowups(t, first.id, 99, "queued");
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_queued_sends").first("n"), 100);
    expect(await t.followup(task.id, input), 409); expect(await t.enqueue(), 503);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_threads").first("n"), 1);
    await assert.rejects(cloneFollowups(t, first.id, 1, "queued"), /agent_queue_limit/);
    await t.h.db.prepare("UPDATE agent_followups SET state='cancelled'").run();
    await cloneFollowups(t, first.id, 900, "cancelled"); expect(await t.followup(task.id, input), 409);
    await assert.rejects(cloneFollowups(t, first.id, 1, "cancelled"), /agent_followup_limit/);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_followups").first("n"), 1000);
    assert.equal(t.messages.length, 1);
  } finally { await t.close(); }
});
