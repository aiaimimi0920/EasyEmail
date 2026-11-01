import assert from "node:assert/strict";
import { test } from "node:test";
import { folderOrganizationFixture, expect } from "./normal-folder-organization-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";
import { putLabel } from "./labels-fixture.mjs";

test("directory organization is complete-target atomic, private, scoped and Origin checked; persisted receipts outlive catalog changes", async () => {
  const t = await folderOrganizationFixture();
  try {
    const sent = expect(await t.messages("Sent")).items[0], other = expect(await t.messages("&Ti1lhw-")).items[0], bob = await t.h.register("folder-org-bob");
    const denied = { cookie: bob.cookie }, key = crypto.randomUUID(), limited = await newKey(t.h, t.alice.cookie, { scopes: ["mail-accounts:read", "messages:read", "messages:write"] });
    const auth = { cookie: undefined, token: limited.token, origin: null };
    expect(await t.organize("Sent", [sent.id, other.id], { isRead: true }), 409);
    expect(await t.organize("Sent", [sent.id], { isRead: true }, undefined, denied), 404);
    expect(await t.taxonomy("Sent", sent.id, "labels", denied), 404);
    expect(await t.organize("Sent", [sent.id], { isRead: true }, undefined, { origin: "https://evil.invalid" }), 403);
    expect(await t.organize("Sent", [sent.id], { trashed: false }, undefined, auth), 403);
    expect(await t.organize("Sent", [sent.id], { folderId: null }, undefined, auth), 403);
    expect(await t.taxonomy("Sent", sent.id, "labels", auth), 403);
    const foreign = crypto.randomUUID(); expect(await putLabel(t.h, bob, foreign), 201);
    expect(await t.organize("Sent", [sent.id], { isRead: true, addLabelIds: [foreign] }), 409);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_message_state").first("n"), 0);
    expect(await t.organize("Sent", [sent.id], { starred: true }, key, auth));
    expect(await t.receipt("Sent", key, denied), 404);
    await t.h.db.prepare("UPDATE normal_server_folder_catalogs SET folders='[]' WHERE account_id=?").bind(t.id).run();
    const held = expect(await t.receipt("Sent", key)); assert.equal(held.operation.serverFolderId, t.folder("Sent").id);
    assert.equal(expect(await t.organize("Sent", [sent.id], { starred: true }, key)).replayed, true);
    expect(await t.organize("Sent", [sent.id], { starred: false }), 404);
    expect(await t.organize("Sent", [sent.id], { isRead: true }, key), 409);
    assert.equal(t.opens.length, 4);
  } finally { await t.close(); }
});

for (const change of ["catalog", "epoch", "generation", "revision", "key", "session"]) test(`atomic directory organization fences late ${change} changes`, async () => {
  const t = await folderOrganizationFixture(); let pending, gate;
  try {
    const row = expect(await t.messages("Sent")).items[0]; let auth = {};
    if (change === "key") { const key = await newKey(t.h, t.alice.cookie, { scopes: ["mail-accounts:read", "messages:read", "messages:write"] }); auth = { cookie: undefined, token: key.token }; }
    gate = t.holdPut(); pending = t.organize("Sent", [row.id], { isRead: true }, undefined, { ...auth, headers: {
      "idempotency-key": crypto.randomUUID(), "x-test-normal-organization": "gate" } }); await gate.entered;
    if (change === "catalog") await t.h.db.prepare("UPDATE normal_server_folder_catalogs SET folders='[]' WHERE account_id=?").bind(t.id).run();
    if (change === "epoch") await t.h.db.prepare("UPDATE normal_server_folder_state SET epoch_id=? WHERE account_id=? AND server_folder_id=?").bind(crypto.randomUUID(), t.id, t.folder("Sent").id).run();
    if (change === "generation") await t.h.db.prepare("UPDATE normal_server_folder_state SET cache_generation=cache_generation+1 WHERE account_id=?").bind(t.id).run();
    if (change === "revision") expect(await t.save({ displayName: "changed" }, 1));
    if (change === "key") await t.h.db.prepare("UPDATE api_keys SET revoked_at=unixepoch() WHERE user_id=?").bind(t.alice.id).run();
    if (change === "session") await t.h.db.prepare("DELETE FROM sessions WHERE user_id=?").bind(t.alice.id).run();
    gate.release(); expect(await pending, 409); pending = null;
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_message_state").first("n"), 0);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_organization_operations").first("n"), 0);
  } finally { gate?.release(); if (pending) await pending; await t.close(); }
});

test("directory organization validates message and committed batch identity and preserves atomic rollback/lost-response replay", async () => {
  const t = await folderOrganizationFixture();
  try {
    const row = expect(await t.messages("Sent")).items[0], stored = await t.h.db.prepare("SELECT * FROM normal_inbox_messages WHERE id=?").bind(row.id).first();
    const batch = await t.h.db.prepare("SELECT * FROM normal_inbox_batches WHERE id=?").bind(stored.batch_id).first();
    for (const [column, value] of [["source_hash", "wrong"], ["epoch_id", crypto.randomUUID()], ["server_folder_id", t.folder("&Ti1lhw-").id]]) {
      await t.h.db.prepare(`UPDATE normal_inbox_batches SET ${column}=? WHERE id=?`).bind(value, batch.id).run();
      expect(await t.organize("Sent", [row.id], { isRead: true }), 409);
      await t.h.db.prepare(`UPDATE normal_inbox_batches SET ${column}=? WHERE id=?`).bind(batch[column], batch.id).run();
    }
    const key = crypto.randomUUID(), headers = mode => ({ "idempotency-key": key, "x-test-normal-organization": mode });
    expect(await t.organize("Sent", [row.id], { isRead: true }, key, { headers: headers("rollback") }), 503);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_message_state").first("n"), 0);
    assert.equal(expect(await t.organize("Sent", [row.id], { isRead: true }, key, { headers: headers("lost") })).replayed, true);
    expect(await t.organize("Sent", [row.id], { isRead: false }));
    assert.equal(expect(await t.organize("Sent", [row.id], { isRead: true }, key)).replayed, true);
    assert.equal(expect(await t.messages("Sent")).items.find(m => m.id === row.id).platformState.isRead, false);
  } finally { await t.close(); }
});

for (const credential of ["key", "session"]) test(`legacy INBOX organization also fences revoked ${credential} credentials`, async () => {
  const t = await folderOrganizationFixture(); let pending, gate;
  try {
    const row = expect(await t.messages("INBOX")).items[0]; let auth = {};
    if (credential === "key") {
      const key = await newKey(t.h, t.alice.cookie, { scopes: ["mail-accounts:read", "messages:read", "messages:write"] });
      auth = { cookie: undefined, token: key.token };
    }
    gate = t.holdPut(); pending = t.request(`${t.base}/messages/organize`, { ...auth, method: "POST",
      headers: { "idempotency-key": crypto.randomUUID(), "x-test-normal-organization": "gate" }, body: { messageIds: [row.id], isRead: true } });
    await gate.entered;
    if (credential === "key") await t.h.db.prepare("UPDATE api_keys SET revoked_at=unixepoch() WHERE user_id=?").bind(t.alice.id).run();
    else await t.h.db.prepare("DELETE FROM sessions WHERE user_id=?").bind(t.alice.id).run();
    gate.release(); expect(await pending, 409); pending = null;
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_message_state").first("n"), 0);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_organization_operations").first("n"), 0);
  } finally { gate?.release(); if (pending) await pending; await t.close(); }
});
