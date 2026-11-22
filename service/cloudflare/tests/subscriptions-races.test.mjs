import assert from "node:assert/strict";
import { test } from "node:test";
import { allocate } from "./provider-fixture.mjs";
import { retentionFixture } from "./retention-fixture.mjs";
import { selectGates } from "./account-race-fixture.mjs";
import { subscriptionsFixture, listMail, sync, subscriptions, subscriptionMembers, hideSubscription, expect } from "./subscriptions-fixture.mjs";

test("same-key contention changes one version; distinct keys compete by CAS and batch failure rolls back receipt/preference", async () => {
  const f = await subscriptionsFixture(); const { h, alice, box } = f;
  try {
    f.f.messages.set(box.address, [listMail(box, 1)]); await sync(f); let item = expect(await subscriptions(h, alice)).items[0];
    const key = crypto.randomUUID(), same = await Promise.all([hideSubscription(h, alice, item, true, key), hideSubscription(h, alice, item, true, key)]);
    same.forEach(result => expect(result)); assert.equal(same.filter(r => r.body.replayed).length, 1);
    item = expect(await subscriptions(h, alice, "visibility=hidden")).items[0]; assert.equal(item.version, 1);
    const different = await Promise.all([hideSubscription(h, alice, item, false), hideSubscription(h, alice, item, true)]);
    assert.deepEqual(different.map(r => r.status).sort(), [200, 409]);
    item = expect(await subscriptions(h, alice, "visibility=all")).items[0]; assert.equal(item.version, 2);
    const operationCount = await h.db.prepare("SELECT COUNT(*) n FROM subscription_operations").first("n");
    await h.db.prepare("CREATE TRIGGER test_subscription_write BEFORE UPDATE OF completed_at ON subscription_operations BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END").run();
    const failedKey = crypto.randomUUID(); expect(await hideSubscription(h, alice, item, !item.hidden, failedKey), 503);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM subscription_operations").first("n"), operationCount);
    assert.equal(expect(await subscriptions(h, alice, "visibility=all")).items[0].version, 2);
    await h.db.prepare("DROP TRIGGER test_subscription_write").run(); expect(await hideSubscription(h, alice, item, !item.hidden, failedKey));
    assert.equal(expect(await subscriptions(h, alice, "visibility=all")).items[0].version, 3);
  } finally { await f.close(); }
});

test("empty receipt snapshot is rechecked after concurrent commit and later preference versions survive replay", async () => {
  const gates = await selectGates(); let f, gate, pending;
  try {
    f = await subscriptionsFixture(false, null, gates.bindings, new URL("./subscriptions-gated-worker.ts", import.meta.url)); const { h, alice, box } = f;
    f.f.messages.set(box.address, [listMail(box, 1)]); await sync(f);
    for (const changed of [false, true]) {
      const item = expect(await subscriptions(h, alice, "visibility=all")).items[0], key = crypto.randomUUID();
      gate = gates.hold(`subscription-receipt-${changed}`, "subscription-operation");
      pending = hideSubscription(h, alice, item, changed ? item.hidden : !item.hidden, key, { headers: { ...gate.headers, "idempotency-key": key } }); await gate.entered();
      const first = expect(await hideSubscription(h, alice, item, !item.hidden, key));
      const latest = expect(await subscriptions(h, alice, "visibility=all")).items[0]; expect(await hideSubscription(h, alice, latest, item.hidden));
      gate.release(); const replay = expect(await pending, changed ? 409 : 200); pending = null;
      if (changed) assert.equal(replay.error.code, "idempotency_conflict"); else { assert.deepEqual(replay.operation, first.operation); assert.equal(replay.replayed, true); }
      assert.equal(expect(await subscriptions(h, alice, "visibility=all")).items[0].version, item.version + 2);
      assert.equal(expect(await subscriptions(h, alice, "visibility=all")).items[0].hidden, item.hidden);
    }
  } finally { gate?.release(); await pending?.catch(() => {}); await f?.close(); await gates.close(); }
});

test("subscription writes share sync lease/batch fences and purge removes PII atomically without reviving tombstones", async () => {
  const f = await subscriptionsFixture(); const { h, alice, box } = f; let gate, pending;
  try {
    f.f.messages.set(box.address, [listMail(box, 1)]); gate = f.f.hold("/cf/api/parsed_mails");
    pending = h.request(`/api/v1/mailboxes/${box.id}/sync`, { cookie: alice.cookie, method: "POST", body: {} }); await gate.entered;
    await h.db.prepare("UPDATE mailboxes SET sync_token=NULL,sync_lease_until=NULL,paused=1 WHERE id=?").bind(box.id).run();
    gate.release(); expect(await pending, 409); pending = null;
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM message_subscriptions").first("n"), 0);
    await h.db.prepare("UPDATE mailboxes SET paused=0 WHERE id=?").bind(box.id).run();
    await h.db.prepare("CREATE TRIGGER test_subscription_sync BEFORE INSERT ON message_subscriptions BEGIN SELECT RAISE(ABORT,'synthetic sync failure'); END").run();
    expect(await h.request(`/api/v1/mailboxes/${box.id}/sync`, { cookie: alice.cookie, method: "POST", body: {} }), 503);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM messages").first("n"), 0);
    await h.db.prepare("DROP TRIGGER test_subscription_sync").run(); await sync(f);
    const item = expect(await subscriptions(h, alice)).items[0]; expect(await hideSubscription(h, alice, item, true));
    const id = expect(await subscriptionMembers(h, alice, item, "visibility=all")).items[0].id, route = `/api/v1/mailboxes/${box.id}/messages/${id}`;
    expect(await h.request(route, { cookie: alice.cookie, method: "DELETE" }));
    await h.db.prepare("CREATE TRIGGER test_subscription_purge BEFORE DELETE ON message_subscriptions BEGIN SELECT RAISE(ABORT,'synthetic purge failure'); END").run();
    expect(await h.request(`${route}/purge`, { cookie: alice.cookie, method: "POST", body: { confirmMessageId: id } }), 500);
    assert.equal(await h.db.prepare("SELECT purged_at FROM messages WHERE id=?").bind(id).first("purged_at"), null);
    await h.db.prepare("DROP TRIGGER test_subscription_purge").run(); expect(await h.request(`${route}/purge`, { cookie: alice.cookie, method: "POST", body: { confirmMessageId: id } }));
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM message_subscriptions").first("n"), 0);
    assert.equal((await sync(f)).inserted, 0); assert.equal(expect(await subscriptions(h, alice, "visibility=all")).items.length, 0);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM subscription_preferences").first("n"), 1);
    const minimal = await h.db.prepare("SELECT * FROM subscription_operations").first(); assert.ok(!JSON.stringify(minimal).includes("unsubscribe.example.test"));
  } finally { gate?.release(); await pending?.catch(() => {}); await f.close(); }
});

test("retention deletes subscription evidence atomically with content and preserves original counts/receipt replay", async () => {
  const a = await retentionFixture(); const { h, alice, f } = a;
  try {
    const box = expect(await allocate(h, alice.cookie), 201).mailbox; f.messages.set(box.address, [listMail(box, 1)]);
    expect(await h.request(`/api/v1/mailboxes/${box.id}/sync`, { cookie: alice.cookie, method: "POST", body: {} }));
    await h.db.prepare("UPDATE messages SET observed_at=unixepoch()-259200").run(); expect(await a.policy({ enabled: true, cacheDays: 1 }));
    await h.db.prepare("CREATE TRIGGER test_subscription_retention BEFORE DELETE ON message_subscriptions BEGIN SELECT RAISE(ABORT,'synthetic retention failure'); END").run();
    const key = crypto.randomUUID(); expect(await a.run(key), 503);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM messages WHERE purged_at IS NOT NULL").first("n"), 0);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM message_subscriptions").first("n"), 1);
    await h.db.prepare("DROP TRIGGER test_subscription_retention").run(); const result = expect(await a.run(key)); assert.equal(result.run.counts.purgedMessages, 1);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM message_subscriptions").first("n"), 0); assert.equal(expect(await a.run(key)).replayed, true);
  } finally { await a.close(); }
});
