import assert from "node:assert/strict";
import { test } from "node:test";
import { normalFlagsFixture } from "./normal-flags-access-fixture.mjs";

test("0053 expands existing 0052 caches without changing content, platform state, checkpoints or legacy mail", async () => {
  const t = await normalFlagsFixture({ through: "0052_provider_sync_cursors.sql" });
  try {
    const before = (await t.h.db.prepare("SELECT * FROM normal_inbox_messages ORDER BY id").all()).results, state = await t.state();
    const message = (await t.message(t.item.id)).body.message;
    assert.equal((await t.h.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='normal_remote_flag_operations'").first()).n, 0);
    await t.h.migrate("0053_normal_remote_flags.sql"); await t.h.migrate("0053_normal_remote_flags.sql");
    assert.deepEqual((await t.h.db.prepare("SELECT * FROM normal_inbox_messages ORDER BY id").all()).results, before);
    assert.deepEqual(await t.state(), state); assert.deepEqual((await t.message(t.item.id)).body.message, message);
    assert.equal((await t.write()).body.operation.state, "confirmed");
    const next = (await t.message(t.item.id)).body.message; assert.deepEqual(next.platformState, message.platformState);
    assert.equal((await t.h.db.prepare("SELECT COUNT(*) n FROM messages").first()).n, 0);
    assert.deepEqual((await t.h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await t.close(); }
});
