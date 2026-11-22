import assert from "node:assert/strict";
import { test } from "node:test";
import { folderOrganizationFixture, expect } from "./normal-folder-organization-fixture.mjs";

test("0055 to 0056 preserves old organization hashes, receipts and private data; legacy writes work before expansion", async () => {
  const t = await folderOrganizationFixture({ through: "0055_normal_server_folder_inbox.sql" });
  try {
    const inbox = expect(await t.messages("INBOX")).items[0], sent = expect(await t.messages("Sent")).items[0], key = crypto.randomUUID();
    const body = { messageIds: [inbox.id], isRead: true }, post = () => t.request(`${t.base}/messages/organize`, { method: "POST", headers: { "idempotency-key": key }, body });
    const before = expect(await post());
    assert.equal(expect(await t.organize("Sent", [sent.id], { starred: true }), 503).error.code, "normal_folder_organization_migration_required");
    const old = await t.h.db.prepare("SELECT * FROM normal_organization_operations").first();
    const tables = ["normal_inbox_state", "normal_server_folder_state", "normal_inbox_messages", "normal_inbox_batches", "normal_message_state"];
    const capture = () => Promise.all(tables.map(async name => [name, (await t.h.db.prepare(`SELECT * FROM ${name}`).all()).results]));
    const data = await capture(); await t.h.migrate(); await t.h.migrate(); assert.deepEqual(await capture(), data);
    const { server_folder_id, ...after } = await t.h.db.prepare("SELECT * FROM normal_organization_operations").first();
    assert.equal(server_folder_id, null); assert.deepEqual(after, old); assert.deepEqual(expect(await post()).operation, before.operation);
    expect(await t.organize("Sent", [sent.id], { starred: true }));
    await t.h.restart(); assert.equal(expect(await t.messages("Sent")).items.find(m => m.id === sent.id).platformState.starred, true);
    assert.deepEqual((await t.h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await t.close(); }
});
