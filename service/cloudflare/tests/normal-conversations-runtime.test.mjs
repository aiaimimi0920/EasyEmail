import assert from "node:assert/strict";
import { test } from "node:test";
import { normalConversationFixture, normalThreadMail, expect } from "./normal-conversations-fixture.mjs";

test("ordinary conversations connect late parents and bridge headers atomically without touching receipt identity", async () => {
  const messages = new Map([[1, normalThreadMail("<child@example.test>", "<ROOT@Example.Test>", "Needle")],
    [2, normalThreadMail("<other@example.test>", "", "Other")], [3, normalThreadMail("<ROOT@example.test>", "", "Late")],
    [4, normalThreadMail("<bridge@example.test>", "<ROOT@example.test> <other@example.test>", "Bridge")]]);
  const t = await normalConversationFixture({ messages });
  try {
    await t.receiveAll(3);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_messages WHERE thread_version=2").first("n"), 3);
    const before = expect(await t.list()); assert.deepEqual(before.items.map(row => row.messageCount).sort(), [1, 2]);
    const state = await t.state(), rows = (await t.h.db.prepare("SELECT id,uid,content_sha256,raw_sha256 FROM normal_inbox_messages ORDER BY id").all()).results;
    const group = expect(await t.list("sources=normal&folder=all&q=Needle")); assert.equal(group.items.length, 1); assert.equal(group.items[0].messageCount, 2);
    const members = expect(await t.members(group.items[0].id)); assert.equal(members.items.length, 2);
    assert.ok(members.items.every(row => row.sourceKind === "normal" && row.accountId === t.id));
    assert.deepEqual(await t.state(), state); assert.deepEqual((await t.h.db.prepare("SELECT id,uid,content_sha256,raw_sha256 FROM normal_inbox_messages ORDER BY id").all()).results, rows);
    await t.receive(); const merged = expect(await t.list()); assert.equal(merged.items.length, 1); assert.equal(merged.items[0].messageCount, 4);
    assert.equal(merged.items[0].basis, "headers"); assert.equal(merged.items[0].unreadCount, 4); assert.equal(t.opens.length, 2);
    await t.h.restart(); assert.equal(expect(await t.list()).items[0].messageCount, 4); assert.equal(t.opens.length, 2);
  } finally { await t.close(); }
});

test("legacy ordinary graph repair reads at most five objects and preserves manifests, hashes and cursor", async () => {
  const messages = new Map(Array.from({ length: 7 }, (_, i) => [i + 1, normalThreadMail(`<m${i}@example.test>`, "<root@example.test>")]));
  const t = await normalConversationFixture({ messages });
  try {
    await t.receiveAll();
    const before = (await t.h.db.prepare("SELECT id,uid,raw_sha256,content_sha256,flags FROM normal_inbox_messages ORDER BY id").all()).results, state = await t.state();
    await t.h.db.prepare("DELETE FROM normal_thread_links").run();
    await t.h.db.prepare("UPDATE normal_inbox_messages SET thread_key=NULL,thread_basis=NULL,thread_version=0,thread_limited=0").run();
    await t.h.db.prepare("DELETE FROM normal_inbox_search").run();
    assert.equal(expect(await t.list(), 409).error.code, "normal_conversation_index_pending");
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_messages WHERE thread_version=2").first("n"), 5);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_search").first("n"), 5);
    await t.h.restart(); assert.equal(expect(await t.list()).items[0].messageCount, 7);
    assert.deepEqual((await t.h.db.prepare("SELECT id,uid,raw_sha256,content_sha256,flags FROM normal_inbox_messages ORDER BY id").all()).results, before);
    assert.deepEqual(await t.state(), state); assert.equal(t.opens.length, 3);
  } finally { await t.close(); }
});

test("ordinary graph keeps RFC local-part case, bounded headers, subject fallback and singles distinct", async () => {
  const messages = new Map([[1, normalThreadMail("<Upper@example.test>")], [2, normalThreadMail("<upper@example.test>")],
    [3, normalThreadMail("", "", "Fallback")], [4, normalThreadMail("", "", "Re: Fallback")],
    [5, normalThreadMail("", "", "")], [6, normalThreadMail("<bounded@example.test>", Array.from({ length: 40 }, (_, i) => `<r${i}@example.test>`).join(" "))]]);
  const t = await normalConversationFixture({ messages });
  try {
    await t.receiveAll(); const page = expect(await t.list()); assert.equal(page.items.length, 5);
    assert.equal(page.items.find(row => row.basis === "subject").messageCount, 2);
    assert.equal(page.items.filter(row => row.basis === "single").length, 1);
    assert.equal(page.items.filter(row => row.limited).length, 1);
    assert.ok(await t.h.db.prepare("SELECT MAX(n) n FROM (SELECT COUNT(*) n FROM normal_thread_links GROUP BY message_id)").first("n") <= 32);
  } finally { await t.close(); }
});
