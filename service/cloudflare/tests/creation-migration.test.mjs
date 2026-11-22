import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "./runtime-harness.mjs";
import { allocate, providerFixture } from "./provider-fixture.mjs";

test("0009 to creation history preserves all old data and tickets while adding only nullable acknowledgement and history index", async () => {
  const f = await providerFixture(); let h;
  try {
    h = await createHarness(f.bindings, false, "0009_allocation_selection.sql");
    const user = await h.register("history-upgrade"), key = crypto.randomUUID();
    const original = await allocate(h, user.cookie, "self", { headers: { "idempotency-key": key } });
    assert.equal(original.status, 201);
    await h.db.prepare(`INSERT INTO mailbox_creations(user_id,request_key,request_hash,mailbox_id,address,state,created_at)
      SELECT user_id,?,request_hash,?,'old-unknown@cf.example.test','unknown',123 FROM mailbox_creations WHERE mailbox_id=?`)
      .bind(crypto.randomUUID(), crypto.randomUUID(), original.body.mailbox.id).run();
    const tables = ["users", "sessions", "mailboxes", "mailbox_creations", "provider_allocation_state", "retention_policy", "retention_runs"];
    const before = {};
    for (const table of tables) before[table] = (await h.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
    await h.migrate(); await h.migrate(); await h.restart();
    for (const table of tables) {
      const rows = (await h.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
      assert.equal(rows.length, before[table].length);
      for (const [index, row] of before[table].entries()) for (const [column, value] of Object.entries(row)) assert.deepEqual(rows[index][column], value, `${table}.${column}`);
    }
    for (const row of (await h.db.prepare("SELECT acknowledged_at FROM mailbox_creations").all()).results) assert.equal(row.acknowledged_at, null);
    const calls = f.calls.length;
    const history = await h.request("/api/v1/mailbox-creations", { cookie: user.cookie });
    assert.equal(history.status, 200); assert.equal(history.body.items.length, 2);
    assert.equal((await allocate(h, user.cookie, "self", { headers: { "idempotency-key": key } })).body.mailbox.id, original.body.mailbox.id);
    assert.equal(f.calls.length, calls);
    console.log(`M3g->M3h preservation evidence: ${h.directory}`);
  } finally { await h?.close(); await f.close(); }
});
