import assert from "node:assert/strict";
import { test } from "node:test";
import { upgradePreservingRows } from "./migration-preservation.mjs";
import { agentAssociationFixture } from "./agent-inbox-association-fixture.mjs";
import { agentReply } from "./agent-inbox-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";

test("0045 is additive, preserves every existing table and row, accepts old-shape writers and enforces overlay ownership", async () => {
  const t = await agentAssociationFixture({ through: "0044_agent_service_senders.sql" });
  try {
    const task = await t.task(); t.scenario({ messages: new Map([[1, agentReply(task.messageId)]]), uidNext: 2 }); expect(await t.receive());
    const tables = (await t.h.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all()).results;
    const snapshots = new Map(); for (const table of tables) snapshots.set(table.name, (await t.h.db.prepare(`SELECT * FROM "${table.name}" ORDER BY rowid`).all()).results);
    await t.h.migrate("0045_agent_review.sql"); await t.h.migrate("0045_agent_review.sql");
    for (const table of tables) {
      assert.equal(await t.h.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").bind(table.name).first("sql"), table.sql, table.name);
      assert.deepEqual((await t.h.db.prepare(`SELECT * FROM "${table.name}" ORDER BY rowid`).all()).results, snapshots.get(table.name), table.name);
    }
    await upgradePreservingRows(t.h, snapshots);
    const original = expect(await t.messages()).items[0], key = crypto.randomUUID();
    const body = { accountRevision: 1, epochId: original.epochId, expectedRevision: 0, state: "linked", threadId: task.id };
    const review = () => t.h.request(`${t.base}/messages/${original.id}/review`, { method: "PUT", cookie: t.alice.cookie, body, headers: { "idempotency-key": key } });
    const receipt = expect(await review()).operation;
    const bob = await t.h.register("manual-migration-bob");
    await assert.rejects(t.h.db.prepare("UPDATE agent_incoming_reviews SET user_id=? WHERE message_id=?").bind(bob.id, original.id).run(), /FOREIGN KEY/);
    await assert.rejects(t.h.db.prepare("UPDATE agent_review_operations SET account_id=? WHERE request_key=?").bind(crypto.randomUUID(), key).run(), /FOREIGN KEY/);
    const old = await t.h.db.prepare("SELECT * FROM agent_incoming_messages WHERE id=?").bind(original.id).first(), nextId = crypto.randomUUID();
    const columns = Object.keys(old), values = columns.map(name => name === "id" ? nextId : name === "uid" ? old.uid + 1 : old[name]);
    await t.h.db.prepare(`INSERT INTO agent_incoming_messages(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).bind(...values).run();
    await t.h.db.prepare("UPDATE agent_incoming_messages SET flags='[\"\\\\Seen\"]' WHERE id=?").bind(nextId).run();
    assert.equal(expect(await t.messages()).items.find(row => row.id === nextId).review.state, "unreviewed");
    await t.h.restart(); assert.deepEqual(expect(await review()).operation, receipt);
    assert.deepEqual(await t.h.db.prepare("PRAGMA foreign_key_check").all().then(result => result.results), []);
  } finally { await t.close(); }
});
