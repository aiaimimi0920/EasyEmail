import assert from "node:assert/strict";
import { test } from "node:test";
import { normalFlagsFixture } from "./normal-flags-access-fixture.mjs";

for (const mode of ["before-insert", "after-insert", "after-dispatch", "before-finish", "after-finish"]) {
  test(`lost database response (${mode}) never authorizes a replayed STORE`, async () => {
    const t = await normalFlagsFixture({ testEntry: "./normal-flags-test-worker.ts", bindings: { TEST_FLAG_FAILURE: mode } }), key = crypto.randomUUID();
    try {
      const result = await t.write(key);
      if (mode === "before-insert") {
        assert.equal(result.status, 503, result.text); assert.equal((await t.operation(key)).status, 404);
        assert.equal(t.calls.some(line => / STORE /.test(line)), false);
        assert.equal((await t.write(key)).body.operation.state, "confirmed");
        const opens = t.opens.length; assert.equal((await t.write(key)).body.operation.state, "confirmed");
        assert.equal(t.opens.length, opens); assert.equal(t.calls.filter(line => / STORE /.test(line)).length, 1); return;
      }
      const expected = { "after-insert": "pending", "after-dispatch": "unknown", "before-finish": "pending", "after-finish": "confirmed" }[mode];
      assert.equal(result.status, mode === "before-finish" ? 503 : mode === "after-dispatch" ? 202 : mode === "after-finish" ? 201 : 200, result.text);
      assert.equal((await t.operation(key)).body.operation.state, expected);
      const stores = t.calls.filter(line => / STORE /.test(line)).length, opens = t.opens.length;
      assert.equal(stores, ["before-finish", "after-finish"].includes(mode) ? 1 : 0);
      const replay = await t.write(key); assert.equal(replay.body.operation.state, expected);
      assert.equal(t.opens.length, opens); assert.equal(t.calls.filter(line => / STORE /.test(line)).length, stores);
      if (expected === "pending") {
        await t.h.db.prepare("UPDATE normal_remote_flag_operations SET created_at=created_at-120 WHERE request_key=?").bind(key).run();
        assert.equal((await t.operation(key)).body.operation.state, "unknown");
        assert.equal((await t.write()).status, 409);
      }
      const message = (await t.message(t.item.id)).body.message;
      assert.equal(message.remoteFlags.includes("\\Flagged"), mode === "after-finish");
    } finally { await t.close(); }
  });
}
