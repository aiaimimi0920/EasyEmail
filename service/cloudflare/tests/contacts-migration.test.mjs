import assert from "node:assert/strict";
import { test } from "node:test";
import { newKey, seedMailbox } from "./runtime-harness.mjs";
import { contactsFixture, saveContact, getContact, expect } from "./contacts-fixture.mjs";

test("0017 expands without modifying old identity/mail/taxonomy data or scopes and persists contacts across restart", async () => {
  const f = await contactsFixture({}, false, "0016_folders.sql"); const { h, alice } = f;
  try {
    const old = await newKey(h, alice.cookie, { scopes: ["mailboxes:read", "messages:read", "folders:read"] });
    const box = await seedMailbox(h, alice.id, "before@example.test");
    const tables = ["users", "sessions", "api_keys", "mailboxes", "messages", "drafts", "labels", "message_labels", "folders", "message_folders", "organization_operations"];
    const before = await Promise.all(tables.map(async table => (await h.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results));
    await h.migrate(); await h.migrate();
    for (let i = 0; i < tables.length; i++) assert.deepEqual((await h.db.prepare(`SELECT * FROM ${tables[i]} ORDER BY rowid`).all()).results, before[i], tables[i]);
    assert.equal(expect(await h.request(`/api/v1/mailboxes/${box}`, { token: old.token })).mailbox.id, box);
    expect(await h.request("/api/v1/contacts", { token: old.token }), 403);
    assert.equal(expect(await h.request("/api/v1/contacts", { cookie: alice.cookie })).items.length, 0);
    const saved = expect(await saveContact(h, alice), 201); const contact = expect(await getContact(h, alice, saved.operation.contactId)).contact;
    await h.restart(); assert.deepEqual(expect(await getContact(h, alice, contact.id)).contact, contact);
    const schema = await h.db.prepare("SELECT sql FROM sqlite_master WHERE name='contact_operations'").first("sql");
    assert.equal(/display_name|email_address|note/.test(schema), false);
  } finally { await f.close(); }
});
