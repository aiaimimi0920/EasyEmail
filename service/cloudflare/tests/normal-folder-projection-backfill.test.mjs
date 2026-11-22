import assert from "node:assert/strict";
import { test } from "node:test";
import { folderProjectionFixture, projectionMailboxes, expect } from "./normal-folder-projection-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";

async function clearProjections(t) {
  await t.h.db.batch([
    t.h.db.prepare("DELETE FROM normal_inbox_search"), t.h.db.prepare("DELETE FROM normal_thread_links"),
    t.h.db.prepare("UPDATE normal_inbox_messages SET thread_version=0,thread_key=NULL"), t.h.db.prepare("DELETE FROM normal_message_subscriptions"),
  ]);
}
async function complete(t, kind, pending) {
  let result, attempts = 0;
  do { result = await t.list(kind); attempts++; if (result.status !== 200) assert.equal(result.body.error.code, pending, result.text); }
  while (result.status === 409 && attempts < 5);
  assert.equal(result.status, 200, result.text); return { ...result.body, attempts };
}
test("historical folder caches backfill five at a time, atomically index new receives, survive restart and retain old-schema readers", async () => {
  const mailboxes = projectionMailboxes(7), sent = mailboxes.get("Sent");
  sent.messages.set(7, new TextEncoder().encode(new TextDecoder().decode(sent.messages.get(7)).replace(/^List-[^\r\n]*\r\n/gm, "")));
  const t = await folderProjectionFixture({ mailboxes });
  try {
    for (let i = 0; i < 3; i++) expect(await t.receive("Sent"));
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_search").first("n"), 7);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_message_subscriptions").first("n"), 7);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_messages WHERE thread_version>0").first("n"), 7);
    for (const [kind, pending] of [["messages", "normal_index_pending"], ["conversations", "normal_conversation_index_pending"], ["subscriptions", "normal_subscription_index_pending"]]) {
      await clearProjections(t); const result = await complete(t, kind, pending); assert.equal(result.attempts, 2);
      assert.equal(result.items.length, kind === "messages" ? 7 : 1);
      assert.equal((await t.list(kind)).status, 200, "backfill is idempotent");
    }
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_message_subscriptions WHERE subscription_key IS NULL").first("n"), 1);
    await t.h.restart(); assert.equal(expect(await t.list("subscriptions")).items[0].messageCount, 6); assert.equal(t.opens.length, 4);
  } finally { await t.close(); }
  const legacy = await folderProjectionFixture({ through: "0054_normal_server_folders.sql" });
  try {
    expect(await legacy.request(`${legacy.base}/sync`, { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: { expectedRevision: 1 } }));
    for (const kind of ["messages", "conversations", "subscriptions"]) assert.ok(expect(await legacy.list(kind)).items.length);
    await legacy.h.migrate(); for (const kind of ["messages", "conversations", "subscriptions"]) assert.ok(expect(await legacy.list(kind)).items.length);
  } finally { await legacy.close(); }
});

for (const [kind, table] of [["messages", "normal_inbox_search"], ["conversations", "normal_thread_links"], ["subscriptions", "normal_message_subscriptions"]]) {
  test(`${kind}: catalog removal and caller revocation during object read fence historical projection writes`, async () => {
    const t = await folderProjectionFixture(); let gate;
    try {
      expect(await t.receive("Sent")); await clearProjections(t);
      const catalog = await t.h.db.prepare("SELECT folders FROM normal_server_folder_catalogs WHERE account_id=?").bind(t.id).first("folders");
      gate = t.holdPut("/get"); const response = t.list(kind); await gate.entered;
      await t.h.db.prepare("UPDATE normal_server_folder_catalogs SET folders='[]' WHERE account_id=?").bind(t.id).run();
      gate.release(); gate = null; expect(await response, 409);
      assert.equal(await t.h.db.prepare(`SELECT COUNT(*) n FROM ${table}`).first("n"), 0);
      await t.h.db.prepare("UPDATE normal_server_folder_catalogs SET folders=? WHERE account_id=?").bind(catalog, t.id).run();
      gate = t.holdPut("/get"); const generationChanged = t.list(kind); await gate.entered;
      await t.h.db.prepare("UPDATE normal_server_folder_state SET cache_generation=cache_generation+1 WHERE account_id=? AND server_folder_id=?")
        .bind(t.id, t.folder("Sent").id).run();
      gate.release(); gate = null; expect(await generationChanged, 409);
      assert.equal(await t.h.db.prepare(`SELECT COUNT(*) n FROM ${table}`).first("n"), 0);
      const key = await newKey(t.h, t.alice.cookie, { scopes: ["messages:read", "mail-accounts:read", "subscriptions:read"] });
      gate = t.holdPut("/get"); const revoked = t.request(`/api/v1/${kind}?sources=normal&folder=all`, { cookie: undefined, token: key.token }); await gate.entered;
      await t.h.db.prepare("UPDATE api_keys SET revoked_at=unixepoch() WHERE user_id=?").bind(t.alice.id).run();
      gate.release(); gate = null; expect(await revoked, 401);
      assert.equal(await t.h.db.prepare(`SELECT COUNT(*) n FROM ${table}`).first("n"), 0);
    } finally { gate?.release(); await t.close(); }
  });
}
