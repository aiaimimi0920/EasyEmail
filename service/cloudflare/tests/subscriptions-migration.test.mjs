import assert from "node:assert/strict";
import { test } from "node:test";
import { newKey } from "./runtime-harness.mjs";
import { seedRetentionMessage } from "./retention-fixture.mjs";
import { subscriptionsFixture, listMail, listHeaders, sync, subscriptions, subscriptionMembers, expect } from "./subscriptions-fixture.mjs";

test("0019 is expand-only: old content, scopes, flags and fingerprints survive, and GET never guesses old subscription evidence", async () => {
  const f = await subscriptionsFixture(false, "0018_conversations.sql"); const { h, alice, box } = f;
  try {
    const key = await newKey(h, alice.cookie, { scopes: ["messages:read"] }); await seedRetentionMessage(h, alice.id, box);
    await h.db.prepare("UPDATE messages SET is_read=1,starred=1").run();
    const tables = ["users", "sessions", "api_keys", "mailboxes", "messages", "contacts", "labels", "folders"];
    const before = await Promise.all(tables.map(async table => (await h.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results));
    await h.migrate(); await h.migrate();
    for (let i = 0; i < tables.length; i++) assert.deepEqual((await h.db.prepare(`SELECT * FROM ${tables[i]} ORDER BY rowid`).all()).results, before[i], tables[i]);
    const calls = f.f.calls.length;
    for (let i = 0; i < 2; i++) assert.equal(expect(await subscriptions(h, alice)).items.length, 0);
    expect(await subscriptions(h, alice, "", { token: key.token, origin: null }), 403);
    await h.restart(); assert.equal(expect(await subscriptions(h, alice)).items.length, 0); assert.equal(f.f.calls.length, calls);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM message_subscriptions").first("n"), 0);
  } finally { await f.close(); }
});

test("metadata-only upgrade preserves message identity and first explicit positive or negative evidence is frozen", async () => {
  const f = await subscriptionsFixture(); const { h, alice, box } = f;
  try {
    const mail = listMail(box, 1); delete mail.subscription_headers; f.f.messages.set(box.address, [mail]); await sync(f);
    const before = await h.db.prepare("SELECT id,fingerprint FROM messages WHERE mailbox_id=?").bind(box.id).first();
    assert.equal(expect(await subscriptions(h, alice)).items.length, 0);
    mail.subscription_headers = listHeaders(); assert.equal((await sync(f)).inserted, 0);
    const item = expect(await subscriptions(h, alice)).items[0]; assert.equal(item.messageCount, 1);
    assert.deepEqual(await h.db.prepare("SELECT id,fingerprint FROM messages WHERE mailbox_id=?").bind(box.id).first(), before);
    mail.subscription_headers = listHeaders({ listId: "Changed <changed.example.test>", unsubscribe: "<https://changed.example.test>" }); await sync(f);
    assert.equal(expect(await subscriptions(h, alice)).items[0].id, item.id); assert.ok(!JSON.stringify(expect(await subscriptions(h, alice))).includes("changed.example.test"));
    const negative = listMail(box, 2, { subscription_headers: listHeaders({ listId: "", unsubscribe: "", unsubscribePost: "", precedence: "" }) });
    f.f.messages.get(box.address).push(negative); await sync(f); negative.subscription_headers = listHeaders(); await sync(f);
    assert.equal(expect(await subscriptions(h, alice)).items[0].messageCount, 1);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM message_subscriptions WHERE subscription_key IS NULL").first("n"), 1);
    expect(await subscriptionMembers(h, alice, item));
  } finally { await f.close(); }
});
