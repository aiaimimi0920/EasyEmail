import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationFixture, threadMail, sync, conversations, members, expect } from "./conversations-fixture.mjs";
import { retentionFixture, seedRetentionMessage } from "./retention-fixture.mjs";
import { allocate } from "./provider-fixture.mjs";

test("thread bridge failure rolls back link merges, cached messages and source metadata in the same sync batch", async () => {
  const f = await conversationFixture(); const { h, alice, box } = f;
  try {
    f.f.messages.set(box.address, [threadMail(box, 1, "<one@example.test>"), threadMail(box, 2, "<two@example.test>")]); await sync(f);
    const before = (await h.db.prepare("SELECT * FROM message_thread_links ORDER BY message_id,token").all()).results;
    await h.db.prepare("CREATE TRIGGER test_thread_failure BEFORE UPDATE OF thread_version ON messages WHEN NEW.remote_id='3' BEGIN SELECT RAISE(ABORT,'synthetic thread failure'); END").run();
    f.f.messages.get(box.address).unshift(threadMail(box, 3, "<bridge@example.test>", "<one@example.test> <two@example.test>"));
    expect(await h.request(`/api/v1/mailboxes/${box.id}/sync`, { cookie: alice.cookie, method: "POST", body: {} }), 503);
    assert.deepEqual((await h.db.prepare("SELECT * FROM message_thread_links ORDER BY message_id,token").all()).results, before);
    assert.equal(expect(await conversations(h, alice)).items.length, 2);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM messages WHERE mailbox_id=?").bind(box.id).first("n"), 2);
    await h.db.prepare("DROP TRIGGER test_thread_failure").run(); await sync(f); assert.equal(expect(await conversations(h, alice)).items[0].messageCount, 3);
  } finally { await f.close(); }
});

test("lost sync lease cannot create thread links and purge removes links atomically without reviving dedup tombstones", async () => {
  const f = await conversationFixture(); const { h, alice, box } = f; let gate, pending;
  try {
    f.f.messages.set(box.address, [threadMail(box, 1, "<one@example.test>")]);
    gate = f.f.hold("/cf/api/parsed_mails"); pending = h.request(`/api/v1/mailboxes/${box.id}/sync`, { cookie: alice.cookie, method: "POST", body: {} }); await gate.entered;
    await h.db.prepare("UPDATE mailboxes SET sync_token=NULL,sync_lease_until=NULL,paused=1 WHERE id=?").bind(box.id).run();
    gate.release(); expect(await pending, 409); pending = null;
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM message_thread_links").first("n"), 0);
    await h.db.prepare("UPDATE mailboxes SET paused=0 WHERE id=?").bind(box.id).run(); await sync(f);
    const id = expect(await conversations(h, alice)).items[0].id, route = `/api/v1/mailboxes/${box.id}/messages/${id}`;
    expect(await h.request(route, { cookie: alice.cookie, method: "DELETE" }));
    await h.db.prepare("CREATE TRIGGER test_thread_purge BEFORE DELETE ON message_thread_links BEGIN SELECT RAISE(ABORT,'synthetic purge failure'); END").run();
    expect(await h.request(`${route}/purge`, { cookie: alice.cookie, method: "POST", body: { confirmMessageId: id } }), 500);
    assert.equal(await h.db.prepare("SELECT purged_at FROM messages WHERE id=?").bind(id).first("purged_at"), null);
    await h.db.prepare("DROP TRIGGER test_thread_purge").run();
    expect(await h.request(`${route}/purge`, { cookie: alice.cookie, method: "POST", body: { confirmMessageId: id } }));
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM message_thread_links WHERE message_id=?").bind(id).first("n"), 0);
    assert.equal((await sync(f)).inserted, 0); expect(await members(h, alice, id), 404);
    assert.equal((await h.db.prepare("SELECT thread_key,thread_basis,rfc_message_id FROM messages WHERE id=?").bind(id).first()).thread_key, null);
  } finally { gate?.release(); await pending?.catch(() => {}); await f.close(); }
});

test("retention removes derived thread links in its atomic purge batch, preserving existing purge counts and receipt replay", async () => {
  const a = await retentionFixture(); const { h, alice } = a;
  try {
    const box = expect(await allocate(h, alice.cookie), 201).mailbox;
    const id = await seedRetentionMessage(h, alice.id, box, { age: 5 }); expect(await conversations(h, alice));
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM message_thread_links WHERE message_id=?").bind(id).first("n"), 1);
    const state = expect(await a.policy({ enabled: true, cacheDays: 1 }));
    const key = crypto.randomUUID(), result = expect(await a.run(key)); assert.equal(result.run.counts.purgedMessages, 1);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM message_thread_links WHERE message_id=?").bind(id).first("n"), 0);
    assert.equal(expect(await a.run(key)).replayed, true); assert.ok(state);
  } finally { await a.close(); }
});
