import assert from "node:assert/strict";
import { test } from "node:test";
import { folderOrganizationFixture, expect } from "./normal-folder-organization-fixture.mjs";
import { putLabel, labelBody } from "./labels-fixture.mjs";
import { putFolder, folderBody } from "./folders-fixture.mjs";

test("directory platform state and taxonomy are source-local, reversible, replayable and never write IMAP", async () => {
  const t = await folderOrganizationFixture();
  try {
    const sent = expect(await t.messages("Sent")).items, inbox = expect(await t.messages("INBOX")).items, key = crypto.randomUUID();
    const label = crypto.randomUUID(), location = crypto.randomUUID();
    expect(await putLabel(t.h, t.alice, label, labelBody("目录标签")), 201);
    expect(await putFolder(t.h, t.alice, location, folderBody("目录位置")), 201);
    const patch = { isRead: true, starred: true, folderId: location, addLabelIds: [label] };
    const first = expect(await t.organize("Sent", sent.map(m => m.id), patch, key));
    assert.equal(first.operation.serverFolderId, t.folder("Sent").id); assert.equal(first.operation.upstreamChanged, false);
    assert.equal(expect(await t.taxonomy("Sent", sent[0].id, "folder")).folder.id, location);
    assert.deepEqual(expect(await t.taxonomy("Sent", sent[0].id, "labels")).items.map(row => row.id), [label]);
    const selected = expect(await t.list("messages", `folderId=${location}&labelId=${label}&isRead=true&starred=true`)).items;
    assert.equal(selected.length, 2); assert.ok(selected.every(row => row.serverFolderId === t.folder("Sent").id));
    assert.equal(expect(await t.messages("Sent")).items.length, 2, "server directory view ignores platform placement");
    assert.ok(expect(await t.messages("INBOX")).items.every(m => !m.platformState.isRead));
    expect(await t.organize("Sent", [sent[0].id], { archived: true, trashed: true, removeLabelIds: [label] }));
    assert.equal(expect(await t.list("messages", "folder=trash")).items[0].id, sent[0].id);
    assert.equal(expect(await t.taxonomy("Sent", sent[0].id, "folder")).folder, null);
    assert.equal(expect(await t.organize("Sent", sent.map(m => m.id).reverse(), patch, key)).replayed, true);
    assert.equal(expect(await t.taxonomy("Sent", sent[0].id, "labels")).items.length, 0);
    expect(await t.organize("Sent", [sent[0].id], { trashed: false }));
    assert.equal(expect(await t.list("messages", "folder=archive")).items[0].id, sent[0].id);
    await t.h.restart(); assert.equal(expect(await t.receipt("Sent", key)).operation.serverFolderId, t.folder("Sent").id);
    assert.equal((await t.organize("Sent", [inbox[0].id], { isRead: true })).status, 409);
    assert.equal(t.opens.length, 4); assert.equal(t.calls.some(line => /STORE|EXPUNGE|COPY|MOVE/.test(line)), false);
  } finally { await t.close(); }
});

test("INBOX alias shares legacy keys and directory guards cannot be replayed into another directory", async () => {
  const t = await folderOrganizationFixture();
  try {
    const inbox = expect(await t.messages("INBOX")).items[0], sent = expect(await t.messages("Sent")).items[0], key = crypto.randomUUID();
    const body = { messageIds: [inbox.id], isRead: true };
    const old = expect(await t.request(`${t.base}/messages/organize`, { method: "POST", headers: { "idempotency-key": key }, body }));
    assert.equal(old.operation.serverFolderId, undefined);
    assert.equal(expect(await t.organize("INBOX", [inbox.id], { isRead: true }, key)).replayed, true);
    assert.equal((await t.organize("Sent", [sent.id], { isRead: true }, key)).status, 409);
    const folderKey = crypto.randomUUID(); expect(await t.organize("Sent", [sent.id], { starred: true }, folderKey));
    assert.equal((await t.receipt("&Ti1lhw-", folderKey)).status, 404);
    assert.equal(expect(await t.request(`${t.base}/organization-operations/${folderKey}`)).operation.serverFolderId, t.folder("Sent").id);
    assert.equal((await t.request(`${t.base}/messages/organize`, { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: { messageIds: [sent.id], isRead: true } })).status, 409);
  } finally { await t.close(); }
});

test("directory and legacy INBOX share the account quota while original receipts survive deleted taxonomy", async () => {
  const t = await folderOrganizationFixture();
  try {
    const sent = expect(await t.messages("Sent")).items[0], inbox = expect(await t.messages("INBOX")).items[0];
    const label = crypto.randomUUID(), location = crypto.randomUUID(), key = crypto.randomUUID();
    expect(await putLabel(t.h, t.alice, label, labelBody("历史标签")), 201);
    expect(await putFolder(t.h, t.alice, location, folderBody("历史位置")), 201);
    const patch = { starred: true, addLabelIds: [label], folderId: location };
    const first = expect(await t.organize("Sent", [sent.id], patch, key)).operation;
    await t.h.db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<9999)
      INSERT INTO normal_organization_operations(account_id,request_key,id,request_hash,account_revision,epoch_id,required_scopes,message_count,created_at,completed_at)
      SELECT o.account_id,o.request_key||'-'||n.x,o.id||'-'||n.x,o.request_hash,o.account_revision,o.epoch_id,o.required_scopes,o.message_count,o.created_at,o.completed_at
      FROM normal_organization_operations o CROSS JOIN n WHERE o.account_id=? AND o.request_key=?`).bind(t.id, key).run();
    await t.h.db.prepare("UPDATE labels SET deleted_at=unixepoch() WHERE id=?").bind(label).run();
    await t.h.db.prepare("UPDATE folders SET deleted_at=unixepoch() WHERE id=?").bind(location).run();
    expect(await t.organize("Sent", [sent.id], { isRead: true }), 409);
    expect(await t.organize("INBOX", [inbox.id], { isRead: true }), 409);
    assert.deepEqual(expect(await t.organize("Sent", [sent.id], patch, key)).operation, first);
    assert.deepEqual(expect(await t.receipt("Sent", key)).operation, first);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_organization_operations").first("n"), 10000);
    assert.equal(expect(await t.messages("Sent")).items.find(m => m.id === sent.id).platformState.isRead, false);
    assert.equal(t.opens.length, 4);
  } finally { await t.close(); }
});
