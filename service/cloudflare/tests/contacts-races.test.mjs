import assert from "node:assert/strict";
import { test } from "node:test";
import { selectGates } from "./account-race-fixture.mjs";
import { contactsFixture, saveContact, contactBody, contactWrite, getContact, expect } from "./contacts-fixture.mjs";

test("same-key PATCH/DELETE recheck receipts and reject changed bodies when a write races the empty receipt snapshot", async () => {
  const gates = await selectGates(); let f, gate, pending;
  try {
    f = await contactsFixture(gates.bindings, false, null, new URL("./account-gated-worker.ts", import.meta.url)); const { h, alice } = f;
    for (const [method, changed] of [["PATCH", false], ["DELETE", false], ["PATCH", true], ["DELETE", true]]) {
      const id = expect(await saveContact(h, alice, contactBody(`${method.toLowerCase()}-${changed}@example.test`)), 201).operation.contactId;
      const key = crypto.randomUUID(), body = { expectedVersion: 1, ...(method === "PATCH" ? { note: "raced" } : {}) };
      const pendingBody = changed ? { ...body, ...(method === "PATCH" ? { note: "different" } : { expectedVersion: 2 }) } : body;
      gate = gates.hold(`receipt-${method}-${changed}`, "contact-operation");
      pending = contactWrite(h, alice, method, id, pendingBody, key, { headers: gate.headers }); await gate.entered();
      const first = expect(await contactWrite(h, alice, method, id, body, key)); gate.release();
      const replay = expect(await pending, changed ? 409 : 200); pending = null;
      if (changed) assert.equal(replay.error.code, "idempotency_conflict");
      else { assert.deepEqual(replay.operation, first.operation); assert.equal(replay.replayed, true); }
      assert.equal(await h.db.prepare("SELECT version FROM contacts WHERE user_id=? AND id=?").bind(alice.id, id).first("version"), 2);
    }
  } finally { gate?.release(); await pending?.catch(() => {}); await f?.close(); await gates.close(); }
});

test("concurrent contact CAS and same-key upserts serialize without duplicate contacts or overwrite by a stale snapshot", async () => {
  const gates = await selectGates(); let f, gateA, gateB, a, b;
  try {
    f = await contactsFixture(gates.bindings, false, null, new URL("./account-gated-worker.ts", import.meta.url)); const { h, alice } = f;
    const id = expect(await saveContact(h, alice), 201).operation.contactId;
    gateA = gates.hold("cas-a", "contact"); gateB = gates.hold("cas-b", "contact");
    a = contactWrite(h, alice, "PATCH", id, { expectedVersion: 1, note: "a" }, crypto.randomUUID(), { headers: gateA.headers });
    b = contactWrite(h, alice, "PATCH", id, { expectedVersion: 1, note: "b" }, crypto.randomUUID(), { headers: gateB.headers });
    await Promise.all([gateA.entered(), gateB.entered()]); gateA.release(); gateB.release();
    const writes = await Promise.all([a, b]); a = b = null; assert.deepEqual(writes.map(row => row.status).sort(), [200, 409]);
    const key = crypto.randomUUID(), body = contactBody("concurrent@example.test");
    const same = await Promise.all([saveContact(h, alice, body, key), saveContact(h, alice, body, key)]);
    assert.deepEqual(same.map(row => row.status).sort(), [200, 201]);
    assert.equal(same[0].body.operation.contactId, same[1].body.operation.contactId);
    const row = expect(await getContact(h, alice, same[0].body.operation.contactId)).contact; assert.equal(row.version, 1);
  } finally { gateA?.release(); gateB?.release(); await a?.catch(() => {}); await b?.catch(() => {}); await f?.close(); await gates.close(); }
});

test("contact insert/update/delete and receipt completion roll back together on actual SQLite trigger failures", async () => {
  const f = await contactsFixture(); const { h, alice } = f;
  try {
    const id = expect(await saveContact(h, alice), 201).operation.contactId;
    await h.db.prepare("CREATE TRIGGER test_contact_failure BEFORE UPDATE OF completed_at ON contact_operations BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END").run();
    for (const [method, target, body] of [["POST", null, contactBody("new@example.test")], ["POST", null, contactBody()],
      ["PATCH", id, { expectedVersion: 1, note: "must roll back" }], ["DELETE", id, { expectedVersion: 1 }]]) {
      const key = crypto.randomUUID(); expect(await contactWrite(h, alice, method, target, body, key), 503);
      assert.equal(expect(await getContact(h, alice, id)).contact.version, 1);
      assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM contact_operations WHERE request_key=?").bind(key).first("n"), 0);
      assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM contacts WHERE user_id=?").bind(alice.id).first("n"), 1);
    }
  } finally { await f.close(); }
});
