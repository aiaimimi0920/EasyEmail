import assert from "node:assert/strict";
import { test } from "node:test";
import { subscriptionsFixture, listMail, listHeaders, subscriptions, subscriptionMembers, hideSubscription, sync, expect } from "./subscriptions-fixture.mjs";

test("subscription groups count complete cached mail, expose bounded methods and preserve per-mail reads and durable hidden preferences", async () => {
  const f = await subscriptionsFixture(); const { h, alice, box } = f;
  try {
    f.f.messages.set(box.address, [listMail(box, 1), listMail(box, 2)]); await sync(f);
    const calls = f.f.calls.length, page = expect(await subscriptions(h, alice)); assert.equal(page.items.length, 1);
    const item = page.items[0]; assert.equal(item.messageCount, 2); assert.equal(item.unreadCount, 2); assert.equal(item.name, "Updates");
    assert.equal(item.hidden, false); assert.equal(item.version, 0); assert.equal(item.methods.length, 2); assert.match(item.id, /^[a-f0-9]{64}$/);
    const members = expect(await subscriptionMembers(h, alice, item)); assert.equal(members.items.length, 2);
    const key = crypto.randomUUID(), hidden = expect(await hideSubscription(h, alice, item, true, key));
    assert.equal(hidden.operation.hidden, true); assert.equal(hidden.operation.version, 1); assert.equal(hidden.replayed, false);
    assert.equal(expect(await subscriptions(h, alice)).items.length, 0);
    const saved = expect(await subscriptions(h, alice, "visibility=hidden")).items[0]; assert.equal(saved.version, 1);
    expect(await hideSubscription(h, alice, saved, false));
    assert.equal(expect(await hideSubscription(h, alice, item, true, key)).replayed, true);
    const current = expect(await subscriptions(h, alice)).items[0]; assert.equal(current.hidden, false); assert.equal(current.version, 2);
    expect(await hideSubscription(h, alice, item, false), 409);
    await h.restart(); assert.equal(expect(await subscriptions(h, alice)).items[0].version, 2);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM messages WHERE mailbox_id=? AND is_read=1").bind(box.id).first("n"), 0);
    assert.equal(f.f.calls.length, calls, "Subscription browsing/hiding must not fetch URLs, send, delete or unsubscribe upstream");
  } finally { await f.close(); }
});

test("subscription methods union across all cached members is de-duplicated and bounded before group pagination", async () => {
  const f = await subscriptionsFixture(); const { h, alice, box } = f;
  try {
    const method = i => `https://unsubscribe.example.test/m${i}`;
    f.f.messages.set(box.address, [listMail(box, 1, { subscription_headers: listHeaders({ unsubscribe: Array.from({ length: 6 }, (_, i) => `<${method(i)}>`).join(",") }) }),
      listMail(box, 2, { subscription_headers: listHeaders({ unsubscribe: Array.from({ length: 6 }, (_, i) => `<${method(i + 4)}>`).join(",") }) })]);
    await sync(f); const item = expect(await subscriptions(h, alice, "limit=1&q=Newsletter%201")).items[0];
    assert.equal(item.messageCount, 2); assert.equal(item.methods.length, 8); assert.equal(item.limited, true);
    assert.deepEqual(item.methods, Array.from({ length: 8 }, (_, i) => method(i)));
    assert.deepEqual(Object.keys(item.latest).sort(), ["id", "mailboxId", "sender", "recipient", "subject", "receivedAt", "observedAt", "mailboxAddress", "providerId", "mailboxDisplayName", "isRead", "starred", "archived"].sort());
  } finally { await f.close(); }
});
