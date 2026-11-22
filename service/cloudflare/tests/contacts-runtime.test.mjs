import assert from "node:assert/strict";
import { test } from "node:test";
import { contactsFixture, contactBody, saveContact, contactWrite, getContact, expect } from "./contacts-fixture.mjs";

test("private contacts preserve normalization, same-email upsert and durable original operation receipts", async () => {
  const f = await contactsFixture(); const { h, alice } = f;
  try {
    const key = crypto.randomUUID(), body = { emailAddress: "  Display <USER@Example.Test>  ", note: "  first  " };
    const first = expect(await saveContact(h, alice, body, key), 201), id = first.operation.contactId;
    const initial = expect(await getContact(h, alice, id)).contact;
    assert.equal(initial.displayName, "User"); assert.equal(initial.emailAddress, "user@example.test"); assert.equal(initial.note, "first"); assert.equal(initial.version, 1);
    const upsert = expect(await saveContact(h, alice, contactBody("user@EXAMPLE.test", "  Updated  ", null)), 201);
    assert.equal(upsert.operation.contactId, id); assert.equal(upsert.operation.version, 2);
    const replay = expect(await saveContact(h, alice, body, key)); assert.equal(replay.replayed, true); assert.equal(replay.operation.version, 1);
    const updated = expect(await getContact(h, alice, id)).contact;
    assert.equal(updated.displayName, "Updated"); assert.equal(updated.note, undefined); assert.equal(updated.version, 2); assert.equal(updated.createdAt, initial.createdAt);
    expect(await saveContact(h, alice, contactBody("other@example.test"), key), 409);
    await h.restart(); assert.deepEqual(expect(await getContact(h, alice, id)).contact, updated);
    assert.equal(expect(await h.request(`/api/v1/contact-operations/${key}`, { cookie: alice.cookie })).operation.version, 1);
  } finally { await f.close(); }
});

test("contact PATCH/DELETE use CAS, preserve omitted fields and never replay stale changes or revive tombstones", async () => {
  const f = await contactsFixture(); const { h, alice } = f;
  try {
    const saved = expect(await saveContact(h, alice), 201), id = saved.operation.contactId, key = crypto.randomUUID();
    const patch = { expectedVersion: 1, note: "new note" };
    expect(await contactWrite(h, alice, "PATCH", id, patch, key));
    expect(await contactWrite(h, alice, "PATCH", id, { expectedVersion: 1, displayName: "stale" }), 409);
    expect(await contactWrite(h, alice, "PATCH", id, { expectedVersion: 2, displayName: "Latest" }));
    assert.equal(expect(await contactWrite(h, alice, "PATCH", id, patch, key)).replayed, true);
    const current = expect(await getContact(h, alice, id)).contact;
    assert.equal(current.displayName, "Latest"); assert.equal(current.note, "new note"); assert.equal(current.emailAddress, "alice@example.test"); assert.equal(current.version, 3);
    const other = expect(await saveContact(h, alice, contactBody("occupied@example.test")), 201);
    expect(await contactWrite(h, alice, "PATCH", id, { expectedVersion: 3, emailAddress: "occupied@example.test" }), 409);
    const deletionKey = crypto.randomUUID(); expect(await contactWrite(h, alice, "DELETE", id, { expectedVersion: 3 }, deletionKey));
    expect(await getContact(h, alice, id), 404); expect(await contactWrite(h, alice, "PATCH", id, { expectedVersion: 4, displayName: "revive" }), 404);
    const replacement = expect(await saveContact(h, alice), 201); assert.notEqual(replacement.operation.contactId, id);
    assert.equal(expect(await contactWrite(h, alice, "DELETE", id, { expectedVersion: 3 }, deletionKey)).replayed, true);
    expect(await getContact(h, alice, replacement.operation.contactId)); expect(await getContact(h, alice, other.operation.contactId));
    const tombstone = await h.db.prepare("SELECT display_name,email_address,note,deleted_at FROM contacts WHERE user_id=? AND id=?").bind(alice.id, id).first();
    assert.equal(tombstone.display_name, ""); assert.equal(tombstone.email_address, ""); assert.equal(tombstone.note, null); assert.ok(tombstone.deleted_at);
  } finally { await f.close(); }
});
