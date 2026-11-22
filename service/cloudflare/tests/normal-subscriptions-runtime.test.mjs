import assert from "node:assert/strict";
import { test } from "node:test";
import { normalSubscriptionsFixture, normalListMail, expect } from "./normal-subscriptions-fixture.mjs";

test("ordinary subscriptions reuse MIME evidence, full-group counts and durable epoch-scoped CAS preferences without external action", async () => {
  const t = await normalSubscriptionsFixture();
  try {
    await t.receiveAll(); assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_message_subscriptions").first("n"), 3);
    const item = expect(await t.list()).items[0]; assert.equal(item.sourceKind, "normal"); assert.equal(item.messageCount, 2);
    assert.equal(item.name, "Updates"); assert.equal(item.version, 0); assert.equal(item.methods.length, 2);
    const rows = expect(await t.members(item, "limit=1")); assert.equal(rows.items.length, 1); assert.ok(rows.nextCursor);
    const next = expect(await t.members(item, `limit=1&cursor=${rows.nextCursor}`)); assert.equal(next.items.length, 1); assert.notEqual(next.items[0].id, rows.items[0].id);
    assert.ok([...rows.items, ...next.items].every(row => row.sourceKind === "normal" && row.accountId === t.id));
    const key = crypto.randomUUID(), hidden = expect(await t.hide(item, true, key)); assert.equal(hidden.operation.version, 1);
    assert.equal(expect(await t.list()).items.length, 0); assert.equal(expect(await t.operation(key)).operation.epochId, item.epochId);
    expect(await t.members(item), 404); const saved = expect(await t.list("sources=normal&visibility=hidden")).items[0];
    expect(await t.hide(saved, false)); assert.equal(expect(await t.hide(item, true, key)).replayed, true);
    const current = expect(await t.list()).items[0]; assert.equal(current.version, 2); assert.equal(current.hidden, false);
    expect(await t.hide(item, false), 409); await t.h.restart(); assert.equal(expect(await t.list()).items[0].version, 2);
    assert.equal(t.opens.length, 1); assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_message_state").first("n"), 0);
  } finally { await t.close(); }
});

test("ordinary subscription method union is bounded before pagination and location filtering selects full cached groups", async () => {
  const method = i => `https://unsubscribe.example.test/m${i}`;
  const messages = new Map([[1, normalListMail(1, { unsubscribe: Array.from({ length: 6 }, (_, i) => `<${method(i)}>`).join(",") })],
    [2, normalListMail(2, { unsubscribe: Array.from({ length: 6 }, (_, i) => `<${method(i + 4)}>`).join(",") })]]);
  const t = await normalSubscriptionsFixture({ messages });
  try {
    await t.receiveAll(); const item = expect(await t.list("sources=normal&q=Newsletter%201&limit=1")).items[0];
    assert.equal(item.messageCount, 2); assert.equal(item.unreadCount, 2); assert.equal(item.limited, true);
    assert.deepEqual(item.methods, Array.from({ length: 8 }, (_, i) => method(i)));
    const members = expect(await t.members(item, "q=Newsletter%201")); assert.equal(members.items.length, 2);
    const id = members.items[0].id; expect(await t.h.request(`${t.base}/messages/organize`, { method: "POST", cookie: t.alice.cookie,
      headers: { "idempotency-key": crypto.randomUUID() }, body: { messageIds: [id], isRead: true, trashed: true } }));
    assert.equal(expect(await t.list()).items[0].messageCount, 1);
    assert.deepEqual(expect(await t.members(item, "folder=trash")).items.map(row => row.id), [id]); assert.equal(t.opens.length, 1);
  } finally { await t.close(); }
});
