import assert from "node:assert/strict";
import { test } from "node:test";
import { selectGates } from "./account-race-fixture.mjs";
import { foldersFixture, folderBody, putFolder, deleteFolder, organize, expect } from "./folders-fixture.mjs";

test("write-time ancestor fences prevent concurrent mutual cycles and parenting to a just-deleted folder", async () => {
  const gates = await selectGates(); let f, gateA, gateB, pendingA, pendingB;
  try {
    f = await foldersFixture(gates.bindings, false, null, new URL("./account-gated-worker.ts", import.meta.url)); const { h, alice } = f;
    const a = crypto.randomUUID(), b = crypto.randomUUID();
    expect(await putFolder(h, alice, a, folderBody("A")), 201); expect(await putFolder(h, alice, b, folderBody("B")), 201);
    gateA = gates.hold("parent-a", "folder-parent"); gateB = gates.hold("parent-b", "folder-parent");
    pendingA = putFolder(h, alice, a, folderBody("A", b, 1), { headers: gateA.headers });
    pendingB = putFolder(h, alice, b, folderBody("B", a, 1), { headers: gateB.headers });
    await Promise.all([gateA.entered(), gateB.entered()]); gateA.release(); gateB.release();
    const results = await Promise.all([pendingA, pendingB]); pendingA = pendingB = null;
    assert.deepEqual(results.map(x => x.status).sort(), [200, 409]);
    const parent = crypto.randomUUID(), child = crypto.randomUUID(); expect(await putFolder(h, alice, parent, folderBody("P")), 201);
    gateA = gates.hold("parent-delete", "folder-parent");
    pendingA = putFolder(h, alice, child, folderBody("C", parent), { headers: gateA.headers }); await gateA.entered();
    expect(await deleteFolder(h, alice, parent, 1)); gateA.release(); expect(await pendingA, 409); pendingA = null;
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM folders WHERE id=?").bind(child).first("n"), 0);
  } finally { gateA?.release(); gateB?.release(); await pendingA?.catch(() => {}); await pendingB?.catch(() => {}); await f?.close(); await gates.close(); }
});

test("target folder deletion after the organization snapshot aborts every write, including flags", async () => {
  const gates = await selectGates(); let f, gate, pending;
  try {
    f = await foldersFixture(gates.bindings, false, null, new URL("./account-gated-worker.ts", import.meta.url)); const { h, alice, ids } = f;
    const folder = crypto.randomUUID(); expect(await putFolder(h, alice, folder), 201);
    gate = gates.hold("move-delete", "organization");
    pending = organize(h, alice, { messageIds: ids, folderId: folder, starred: true }, crypto.randomUUID(), { headers: { ...gate.headers, "idempotency-key": crypto.randomUUID() } });
    await gate.entered(); expect(await deleteFolder(h, alice, folder, 1)); gate.release(); expect(await pending, 409); pending = null;
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM messages WHERE starred=1").first("n"), 0);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM organization_operations").first("n"), 0);
  } finally { gate?.release(); await pending?.catch(() => {}); await f?.close(); await gates.close(); }
});

test("folder deletion, batch placement and legacy archive changes roll back atomically on SQL faults", async () => {
  const f = await foldersFixture(); const { h, alice, box, ids } = f;
  try {
    const parent = crypto.randomUUID(), child = crypto.randomUUID();
    expect(await putFolder(h, alice, parent), 201); expect(await putFolder(h, alice, child, folderBody("子", parent)), 201);
    await h.db.prepare("CREATE TRIGGER test_folder_insert BEFORE INSERT ON message_folders BEGIN SELECT RAISE(ABORT,'synthetic failure'); END").run();
    const key = crypto.randomUUID(), body = { messageIds: ids, folderId: parent, starred: true };
    expect(await organize(h, alice, body, key), 503);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM messages WHERE starred=1").first("n"), 0);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM organization_operations").first("n"), 0);
    await h.db.prepare("DROP TRIGGER test_folder_insert").run(); expect(await organize(h, alice, body, key));
    await h.db.prepare("CREATE TRIGGER test_folder_delete BEFORE DELETE ON message_folders BEGIN SELECT RAISE(ABORT,'synthetic failure'); END").run();
    expect(await deleteFolder(h, alice, parent, 1), 503);
    assert.equal(await h.db.prepare("SELECT deleted_at FROM folders WHERE id=?").bind(parent).first("deleted_at"), null);
    assert.equal(await h.db.prepare("SELECT parent_id FROM folders WHERE id=?").bind(child).first("parent_id"), parent);
    expect(await h.request(`/api/v1/mailboxes/${box}/messages/${ids[0]}`, { method: "PATCH", cookie: alice.cookie, body: { archived: true } }), 500);
    assert.equal(await h.db.prepare("SELECT archived FROM messages WHERE id=?").bind(ids[0]).first("archived"), 0);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM message_folders").first("n"), 2);
  } finally { await f.close(); }
});
