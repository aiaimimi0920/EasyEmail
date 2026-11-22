import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationFixture, threadMail, sync, conversations, members, expect } from "./conversations-fixture.mjs";

test("server conversations join late parent/bridge headers across sync pages, restart and unchanged content identities", async () => {
  const f = await conversationFixture(); const { h, alice, box } = f;
  try {
    f.f.messages.set(box.address, [threadMail(box, 1, "<child@example.test>", "<parent@example.test>")]);
    assert.equal((await sync(f)).inserted, 1);
    const before = expect(await conversations(h, alice)); assert.equal(before.items.length, 1);
    const anchor = before.items[0].id; assert.equal(before.items[0].messageCount, 1);
    f.f.messages.set(box.address, [threadMail(box, 2, "<root@example.test>"), threadMail(box, 1, "<child@example.test>", "<parent@example.test>")]);
    assert.equal((await sync(f)).inserted, 1); assert.equal(expect(await conversations(h, alice)).items.length, 2);
    f.f.messages.set(box.address, [threadMail(box, 3, "<parent@example.test>", "<root@example.test>"), ...f.f.messages.get(box.address)]);
    assert.equal((await sync(f)).inserted, 1); assert.equal((await sync(f)).inserted, 0);
    const page = expect(await conversations(h, alice)); assert.equal(page.items.length, 1); assert.equal(page.items[0].messageCount, 3);
    assert.equal(page.items[0].unreadCount, 3); assert.equal(page.items[0].basis, "headers");
    const first = expect(await members(h, alice, anchor, "folder=all&limit=2")); assert.equal(first.items.length, 2); assert.ok(first.nextCursor);
    const last = expect(await members(h, alice, anchor, `folder=all&limit=2&cursor=${first.nextCursor}`)); assert.equal(last.items.length, 1);
    assert.equal(new Set([...first.items, ...last.items].map(item => item.id)).size, 3);
    await h.restart(); assert.equal(expect(await conversations(h, alice)).items[0].messageCount, 3);
  } finally { await f.close(); }
});

test("header-less subject fallback is explicit, but blank subjects/invalid senders stay independent and late header upgrades preserve cached IDs", async () => {
  const f = await conversationFixture(); const { h, alice, box } = f;
  try {
    const root = threadMail(box, 1, "<root@example.test>", "", "Root"), child = threadMail(box, 2, "<child@example.test>", "", "Different subject");
    delete child.thread_headers;
    f.f.messages.set(box.address, [root, child, threadMail(box, 3, null, "", "RE: 回复: Shared"), threadMail(box, 4, null, "", "Shared"),
      threadMail(box, 5, null, "", ""), threadMail(box, 6, null, "", "")]);
    await sync(f); const initial = expect(await conversations(h, alice)); assert.equal(initial.items.length, 5);
    assert.equal(initial.items.find(item => item.basis === "subject").messageCount, 2);
    const oldId = await h.db.prepare("SELECT id FROM messages WHERE remote_id='2' AND mailbox_id=?").bind(box.id).first("id");
    child.thread_headers = { version: 1, inReplyTo: "<root@example.test>", references: "<root@example.test>" };
    assert.equal((await sync(f)).inserted, 0);
    assert.equal((await h.db.prepare("SELECT thread_version FROM messages WHERE id=?").bind(oldId).first("thread_version")), 2);
    assert.equal(expect(await members(h, alice, oldId)).items.length, 2);
    root.thread_headers = { version: 1, inReplyTo: "<unrelated@example.test>", references: "<unrelated@example.test>" };
    await sync(f); assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM messages WHERE mailbox_id=?").bind(box.id).first("n"), 6);
    assert.equal(expect(await conversations(h, alice)).items.length, 4);
  } finally { await f.close(); }
});

test("conversation pagination counts complete server groups, not just the current message or member page", async () => {
  const f = await conversationFixture(); const { h, alice, box } = f;
  try {
    const rows = Array.from({ length: 31 }, (_, i) => threadMail(box, i + 1, `<m${i}@example.test>`, "<root@example.test>"));
    rows.push(threadMail(box, 40, "<other@example.test>", "", "Other")); f.f.messages.set(box.address, rows);
    for (let page = 1; page <= 4; page++) await sync(f, box, page);
    const a = expect(await conversations(h, alice, "folder=all&limit=1")); assert.equal(a.items.length, 1); assert.ok(a.nextCursor);
    const b = expect(await conversations(h, alice, `folder=all&limit=1&cursor=${a.nextCursor}`)); assert.equal(b.nextCursor, null);
    const joined = [...a.items, ...b.items].find(item => item.messageCount === 31); assert.ok(joined); assert.equal(joined.unreadCount, 31);
    const first = expect(await members(h, alice, joined.id)); assert.equal(first.items.length, 25); assert.ok(first.nextCursor);
    const next = expect(await members(h, alice, joined.id, `folder=all&cursor=${first.nextCursor}`)); assert.equal(next.items.length, 6);
    assert.equal(new Set([...first.items, ...next.items].map(item => item.id)).size, 31);
    expect(await conversations(h, alice, `folder=all&cursor=${first.nextCursor}`), 400);
    expect(await members(h, alice, joined.id, `folder=all&cursor=${a.nextCursor}`), 400);
  } finally { await f.close(); }
});
