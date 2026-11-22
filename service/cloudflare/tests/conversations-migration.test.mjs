import assert from "node:assert/strict";
import { test } from "node:test";
import { newKey } from "./runtime-harness.mjs";
import { seedRetentionMessage } from "./retention-fixture.mjs";
import { conversationFixture, threadMail, sync, conversations, members, expect } from "./conversations-fixture.mjs";

test("0018 preserves old rows/scopes/fingerprints and bounded legacy warmup converges across concurrent reads and restart", async () => {
  const f = await conversationFixture(false, "0017_contacts.sql"); const { h, alice, box } = f;
  try {
    const reader = await newKey(h, alice.cookie, { scopes: ["messages:read"] });
    const ids = [];
    for (let i = 0; i < 23; i++) ids.push(await seedRetentionMessage(h, alice.id, box));
    await h.db.prepare("UPDATE messages SET is_read=1,starred=1 WHERE id=?").bind(ids[0]).run();
    const tables = ["users", "sessions", "api_keys", "mailboxes", "messages", "labels", "folders", "contacts"];
    const before = await Promise.all(tables.map(async table => (await h.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results));
    await h.migrate(); await h.migrate();
    for (let i = 0; i < tables.length; i++) {
      const current = (await h.db.prepare(`SELECT * FROM ${tables[i]} ORDER BY rowid`).all()).results;
      const columns = Object.keys(before[i][0] ?? {});
      assert.deepEqual(current.map(row => Object.fromEntries(columns.map(key => [key, row[key]]))), before[i], tables[i]);
    }
    const calls = f.f.calls.length;
    assert.equal(expect(await conversations(h, alice), 503).error.code, "conversation_index_pending");
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM messages WHERE thread_version=1").first("n"), 20);
    const reads = await Promise.all([conversations(h, alice), conversations(h, alice)]);
    for (const result of reads) assert.equal(expect(result).items[0].messageCount, 23);
    assert.equal(f.f.calls.length, calls, "Warmup must not contact a supplier");
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM message_thread_links").first("n"), 23);
    expect(await conversations(h, alice, "folder=all", { token: reader.token, origin: null }));
    await h.restart(); assert.equal(expect(await members(h, alice, ids[0])).items.length, 23);
    const rows = (await h.db.prepare("SELECT id,fingerprint,is_read,starred FROM messages ORDER BY rowid").all()).results;
    assert.deepEqual(rows, before[4].map(({ id, fingerprint, is_read, starred }) => ({ id, fingerprint, is_read, starred })));
  } finally { await f.close(); }
});

test("legacy warmup never downgrades explicit header evidence and metadata upgrade cannot duplicate content or resurrect purged mail", async () => {
  const f = await conversationFixture(); const { h, alice, box } = f;
  try {
    const mail = threadMail(box, 1, "<legacy@example.test>"); delete mail.thread_headers;
    f.f.messages.set(box.address, [mail]); await sync(f);
    const before = await h.db.prepare("SELECT id,fingerprint FROM messages WHERE mailbox_id=?").bind(box.id).first();
    await h.db.batch([h.db.prepare("DELETE FROM message_thread_links WHERE message_id=?").bind(before.id),
      h.db.prepare("UPDATE messages SET thread_version=0,thread_key=NULL,thread_basis=NULL WHERE id=?").bind(before.id)]);
    mail.thread_headers = { version: 1, inReplyTo: "<parent@example.test>", references: "<parent@example.test>" };
    await Promise.all([sync(f), conversations(h, alice)]);
    await sync(f);
    assert.equal(await h.db.prepare("SELECT thread_version FROM messages WHERE id=?").bind(before.id).first("thread_version"), 2);
    assert.deepEqual(await h.db.prepare("SELECT id,fingerprint FROM messages WHERE mailbox_id=?").bind(box.id).first(), before);
    const route = `/api/v1/mailboxes/${box.id}/messages/${before.id}`;
    expect(await h.request(route, { cookie: alice.cookie, method: "DELETE" }));
    expect(await h.request(`${route}/purge`, { cookie: alice.cookie, method: "POST", body: { confirmMessageId: before.id } }));
    await h.restart(); await sync(f); assert.equal(expect(await conversations(h, alice)).items.length, 0);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM message_thread_links").first("n"), 0);
  } finally { await f.close(); }
});
