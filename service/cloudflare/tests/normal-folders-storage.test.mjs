import assert from "node:assert/strict";
import { test } from "node:test";
import { normalFoldersFixture } from "./normal-folders-fixture.mjs";

for (const mode of ["after-claim", "before-publish", "after-publish"]) {
  test(`database ambiguity (${mode}) is checked via cached GET, never an automatic new LIST`, async () => {
    const t = await normalFoldersFixture({ testEntry: "./normal-folders-test-worker.ts" });
    try {
      const first = (await t.discover()).body.catalog;
      await t.h.restart({ TEST_FOLDER_FAILURE: mode });
      const result = await t.discover(); assert.equal(result.status, 503, result.text);
      const opens = t.opens.length, cached = (await t.cached()).body.catalog;
      assert.equal(opens, mode === "after-claim" ? 1 : 2); assert.equal(t.opens.length, opens);
      if (mode === "after-publish") { assert.notEqual(cached.snapshotId, first.snapshotId); assert.deepEqual(cached.items, first.items); }
      else assert.deepEqual(cached, first);
      assert.equal((await t.h.db.prepare("SELECT claim_token FROM normal_server_folder_catalogs WHERE account_id=?").bind(t.id).first()).claim_token, null);
      assert.equal(t.calls.some(line => /STORE|EXPUNGE|MOVE/.test(line)), false);
    } finally { await t.close(); }
  });
}
