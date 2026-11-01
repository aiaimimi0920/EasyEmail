import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "./runtime-harness.mjs";
import { providerFixture } from "./provider-fixture.mjs";
import { seedLegacyCloudflare } from "./legacy-mailbox-fixture.mjs";
import { allocate } from "./provider-fixture.mjs";

test("0008 to allocation selection preserves every legacy column, pending guards and retention policies without inventing provider attribution", async () => {
  const f = await providerFixture(); let h;
  try {
    h = await createHarness(f.bindings, false, "0008_retention.sql");
    const user = await h.register("selection-upgrade"), box = await seedLegacyCloudflare(h, f, user.id);
    const pendingKey = crypto.randomUUID(), pendingId = crypto.randomUUID();
    await h.db.prepare(`INSERT INTO mailbox_creations(user_id,request_key,request_hash,mailbox_id,address,state,created_at)
      SELECT user_id,?,request_hash,?,'unknown@cf.example.test','unknown',123 FROM mailbox_creations WHERE mailbox_id=?`)
      .bind(pendingKey, pendingId, box.id).run();
    await h.db.prepare("UPDATE mailboxes SET expires_at=unixepoch()+86400 WHERE id=?").bind(box.id).run();
    await h.db.prepare("UPDATE retention_policy SET enabled=1,mailbox_days=1,cache_days=30,revision=5").run();
    const tables = ["users", "sessions", "mailboxes", "mailbox_creations", "retention_policy", "retention_policy_changes", "retention_runs"];
    const before = {};
    for (const table of tables) before[table] = (await h.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
    await h.migrate(); await h.migrate(); await h.restart();
    for (const table of tables) {
      const rows = (await h.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
      assert.equal(rows.length, before[table].length);
      for (const [index, row] of before[table].entries()) for (const [field, value] of Object.entries(row)) assert.deepEqual(rows[index][field], value, `${table}.${field}`);
    }
    for (const row of (await h.db.prepare("SELECT * FROM mailbox_creations").all()).results) {
      for (const field of ["provider_id", "provider_revision", "provider_hash"]) assert.equal(row[field], null);
    }
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM provider_allocation_state").first()).n, 0);
    const replay = await allocate(h, user.cookie, "self", { headers: { "idempotency-key": pendingKey } });
    assert.equal(replay.status, 202); assert.equal(replay.body.creation.state, "unknown"); assert.equal(replay.body.creation.providerId, null);
    assert.equal(replay.body.creation.address, "unknown@cf.example.test"); assert.equal(f.calls.length, 0);
    console.log(`M3f->M3g preservation evidence: ${h.directory}`);
  } finally { await h?.close(); await f.close(); }
});
