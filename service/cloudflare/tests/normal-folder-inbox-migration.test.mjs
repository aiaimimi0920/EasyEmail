import assert from "node:assert/strict";
import { test } from "node:test";
import { normalFolderInboxFixture } from "./normal-folder-inbox-fixture.mjs";

test("0054 to 0055 preserves INBOX cursor, messages, receipts and catalog; repeated apply is inert", async () => {
  const t = await normalFolderInboxFixture({ through: "0054_normal_server_folders.sql" });
  try {
    const key = crypto.randomUUID();
    const received = await t.request(`${t.base}/sync`, { method: "POST", headers: { "idempotency-key": key }, body: { expectedRevision: 1 } });
    assert.equal(received.body.request.state, "committed", received.text);
    const tables = ["normal_inbox_state", "normal_inbox_requests", "normal_inbox_batches", "normal_inbox_messages", "normal_server_folder_catalogs"];
    const capture = () => Promise.all(tables.map(async table => [table, (await t.h.db.prepare(`SELECT * FROM ${table}`).all()).results
      .map(({ server_folder_id, server_request_id, ...row }) => row)]));
    const before = await capture(); await t.h.migrate(); await t.h.migrate(); assert.deepEqual(await capture(), before);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_messages WHERE server_folder_id IS NOT NULL").first("n"), 0);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_batches WHERE server_folder_id IS NOT NULL OR server_request_id IS NOT NULL").first("n"), 0);
    assert.equal((await t.receive("INBOX", key)).body.request.state, "committed");
    assert.equal((await t.messages("INBOX")).body.items[0].subject, "Inbox mail");
    assert.equal((await t.receive("Sent")).body.request.state, "committed");
    assert.deepEqual((await t.h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await t.close(); }
});
