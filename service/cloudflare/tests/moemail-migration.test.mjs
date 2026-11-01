import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness, seedMailbox } from "./runtime-harness.mjs";
import { allocate, cfMail, providerFixture } from "./provider-fixture.mjs";

test("0052 expands cursor storage without rewriting existing mailboxes, credentials, messages or numeric-page providers", async () => {
  const f = await providerFixture();
  let h;
  try {
    h = await createHarness(f.bindings, false, "0051_agent_google_oauth.sql");
    const alice = await h.register("moemail-migration-alice");
    const mailbox = (await allocate(h, alice.cookie)).body.mailbox;
    f.messages.set(mailbox.address, [cfMail(mailbox.address, 1)]);
    const sync = () => h.request(`/api/v1/mailboxes/${mailbox.id}/sync`, { method: "POST", cookie: alice.cookie, body: {} });
    assert.equal((await sync()).status, 200, "Existing adapters do not query a cursor table before expansion");
    const before = await h.db.prepare("SELECT * FROM mailboxes WHERE id=?").bind(mailbox.id).first();
    const messages = (await h.db.prepare("SELECT * FROM messages WHERE mailbox_id=?").bind(mailbox.id).all()).results;
    await h.migrate();
    assert.deepEqual(await h.db.prepare("SELECT * FROM mailboxes WHERE id=?").bind(mailbox.id).first(), before);
    assert.deepEqual((await h.db.prepare("SELECT * FROM messages WHERE mailbox_id=?").bind(mailbox.id).all()).results, messages);
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM provider_sync_cursors").first()).n, 0);
    assert.equal((await sync()).body.sync.inserted, 0);
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM provider_sync_cursors").first()).n, 0);
    const other = await seedMailbox(h, alice.id, "cursor-delete@example.test");
    await h.db.prepare("INSERT INTO provider_sync_cursors VALUES (?,?,2,'synthetic+/cursor')").bind(other, alice.id).run();
    await h.db.prepare("DELETE FROM mailboxes WHERE id=?").bind(other).run();
    assert.equal(await h.db.prepare("SELECT * FROM provider_sync_cursors WHERE mailbox_id=?").bind(other).first(), null);
    assert.deepEqual((await h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await h?.close(); await f.close(); }
});
