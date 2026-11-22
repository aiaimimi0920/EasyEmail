import assert from "node:assert/strict";
import { test } from "node:test";
import { normalFoldersFixture } from "./normal-folders-fixture.mjs";

test("0054 is additive and repeatable; existing INBOX content, cursor, flags guards and platform folders remain unchanged", async () => {
  const t = await normalFoldersFixture({ through: "0053_normal_remote_flags.sql" });
  try {
    const base = `/api/v1/normal-accounts/${t.id}`, key = crypto.randomUUID();
    const sync = await t.h.request(`${base}/sync`, { method: "POST", cookie: t.alice.cookie,
      headers: { "idempotency-key": key }, body: { expectedRevision: 1 } });
    assert.equal(sync.body.request.state, "committed", sync.text);
    const tables = ["normal_accounts", "normal_inbox_state", "normal_inbox_batches", "normal_inbox_messages", "normal_remote_flag_operations", "folders", "messages"];
    const capture = () => Promise.all(tables.map(async table => [table, (await t.h.db.prepare(`SELECT * FROM ${table}`).all()).results]));
    const before = await capture(); await t.h.migrate("0054_normal_server_folders.sql"); await t.h.migrate("0054_normal_server_folders.sql"); assert.deepEqual(await capture(), before);
    assert.equal((await t.cached()).body.catalog.current, false);
    assert.equal((await t.discover()).body.catalog.items.length, 5); assert.deepEqual(await capture(), before);
    assert.equal((await t.h.request(`${base}/messages`, { cookie: t.alice.cookie })).body.items.length > 0, true);
    assert.deepEqual((await t.h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await t.close(); }
});
