import assert from "node:assert/strict";
import { test } from "node:test";
import { selectGates } from "./account-race-fixture.mjs";
import { labelsFixture, labelBody, labelPath, putLabel, organize, expect } from "./labels-fixture.mjs";

test("purge or label deletion after the authorization snapshot fences the entire organization transaction", async () => {
  const gates = await selectGates(); let f, gate, pending;
  try {
    f = await labelsFixture(gates.bindings, false, null, new URL("./account-gated-worker.ts", import.meta.url));
    const { h, alice, box, ids } = f;
    for (const mode of ["purge", "label-delete"]) {
      const label = crypto.randomUUID(); expect(await putLabel(h, alice, label, labelBody(mode)), 201);
      gate = gates.hold(mode, "organization");
      pending = organize(h, alice, { messageIds: ids, isRead: true, addLabelIds: [label] }, crypto.randomUUID(),
        { headers: { ...gate.headers, "idempotency-key": crypto.randomUUID() } });
      await gate.entered();
      if (mode === "purge") {
        expect(await h.request(`/api/v1/mailboxes/${box}/messages/${ids[1]}`, { method: "DELETE", cookie: alice.cookie }));
        expect(await h.request(`/api/v1/mailboxes/${box}/messages/${ids[1]}/purge`, { method: "POST", cookie: alice.cookie, body: { confirmMessageId: ids[1] } }));
      } else expect(await h.request(labelPath(label), { method: "DELETE", cookie: alice.cookie, body: { expectedRevision: 1 } }));
      gate.release(); expect(await pending, 409); pending = null;
      assert.equal(await h.db.prepare("SELECT is_read FROM messages WHERE id=?").bind(ids[0]).first("is_read"), 0);
      assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM organization_operations").first("n"), 0);
      if (mode === "purge") await h.db.prepare("UPDATE messages SET purged_at=NULL,trashed_at=NULL WHERE id=?").bind(ids[1]).run();
    }
  } finally { gate?.release(); await pending?.catch(() => {}); await f?.close(); await gates.close(); }
});

test("real SQLite write failure rolls back flags, labels and the receipt; concurrent duplicate requests execute once", async () => {
  const f = await labelsFixture();
  try {
    const { h, alice, ids } = f, label = crypto.randomUUID(); expect(await putLabel(h, alice, label), 201);
    await h.db.prepare("CREATE TRIGGER test_organization_failure BEFORE INSERT ON message_labels BEGIN SELECT RAISE(ABORT,'synthetic failure'); END").run();
    const key = crypto.randomUUID(), body = { messageIds: ids, starred: true, addLabelIds: [label] };
    expect(await organize(h, alice, body, key), 503);
    assert.equal(await h.db.prepare("SELECT starred FROM messages WHERE id=?").bind(ids[0]).first("starred"), 0);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM organization_operations").first("n"), 0);
    await h.db.prepare("DROP TRIGGER test_organization_failure").run();
    const result = await Promise.all([organize(h, alice, body, key), organize(h, alice, body, key)]);
    result.forEach(value => expect(value)); assert.equal(result.filter(value => value.body.replayed === false).length, 1);
    assert.equal(new Set(result.map(value => value.body.operation.id)).size, 1);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM message_labels").first("n"), 2);
    const conflictKey = crypto.randomUUID();
    const conflict = await Promise.all([organize(h, alice, { messageIds: ids, isRead: true }, conflictKey),
      organize(h, alice, { messageIds: ids, isRead: false }, conflictKey)]);
    assert.deepEqual(conflict.map(value => value.status).sort(), [200, 409]);
    assert.equal(await h.db.prepare("SELECT is_read FROM messages WHERE id=?").bind(ids[0]).first("is_read"), conflict[0].status === 200 ? 1 : 0);
    await h.db.prepare("CREATE TRIGGER test_label_delete_failure BEFORE DELETE ON message_labels BEGIN SELECT RAISE(ABORT,'synthetic failure'); END").run();
    expect(await h.request(labelPath(label), { method: "DELETE", cookie: alice.cookie, body: { expectedRevision: 1 } }), 503);
    assert.equal(await h.db.prepare("SELECT deleted_at FROM labels WHERE id=?").bind(label).first("deleted_at"), null);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM message_labels").first("n"), 2);
  } finally { await f.close(); }
});
