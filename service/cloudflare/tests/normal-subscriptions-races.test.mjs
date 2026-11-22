import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { normalSubscriptionsFixture, normalListMail, expect } from "./normal-subscriptions-fixture.mjs";

async function unindex(t) { await t.h.db.prepare("DELETE FROM normal_message_subscriptions").run(); await t.h.db.prepare("DELETE FROM normal_inbox_search").run(); }
test("empty ordinary receipt snapshots recheck same-key same/different payload commits without overwriting later preferences", async () => {
  const t = await normalSubscriptionsFixture({ testEntry: "./normal-subscriptions-gated-worker.ts" }); let gate, pending;
  try {
    await t.receiveAll();
    for (const changed of [false, true]) {
      const item = expect(await t.list("sources=normal&visibility=all")).items[0], key = crypto.randomUUID(); gate = t.holdPut("/get");
      pending = t.hide(item, changed ? item.hidden : !item.hidden, key, { headers: { "idempotency-key": key, "x-test-normal-subscription": "receipt" } }); await gate.entered;
      const first = expect(await t.hide(item, !item.hidden, key)), latest = expect(await t.list("sources=normal&visibility=all")).items[0];
      expect(await t.hide(latest, item.hidden)); gate.release(); const replay = expect(await pending, changed ? 409 : 200); pending = null;
      if (changed) assert.equal(replay.error.code, "idempotency_conflict"); else { assert.deepEqual(replay.operation, first.operation); assert.equal(replay.replayed, true); }
      const current = expect(await t.list("sources=normal&visibility=all")).items[0]; assert.equal(current.version, item.version + 2); assert.equal(current.hidden, item.hidden);
    }
  } finally { gate?.release(); await pending?.catch(() => {}); await t.close(); }
});

for (const change of ["revision", "source", "epoch", "delete", "user", "batch", "trash"]) test(`ordinary subscription SQL write fence rejects ${change} change between context read and batch`, async () => {
  const t = await normalSubscriptionsFixture({ testEntry: "./normal-subscriptions-gated-worker.ts" }); let gate, pending;
  try {
    await t.receiveAll(); const item = expect(await t.list()).items[0], key = crypto.randomUUID(); gate = t.holdPut("/get");
    pending = t.hide(item, true, key, { headers: { "idempotency-key": key, "x-test-normal-subscription": "batch" } }); await gate.entered;
    if (change === "revision") expect(await t.save({ displayName: "Updated" }, 1));
    if (change === "source") expect(await t.save({ username: "new-source" }, 1));
    if (change === "epoch") { t.scenario({ validity: "43", messages: t.sourceMessages, uidNext: 4 }); await t.receiveAll(); }
    if (change === "delete") expect(await t.h.request(t.base, { method: "DELETE", cookie: t.alice.cookie, headers: { "idempotency-key": crypto.randomUUID() }, body: { expectedRevision: 1 } }));
    if (change === "user") await t.h.db.prepare("UPDATE users SET status='disabled' WHERE id=?").bind(t.alice.id).run();
    if (change === "batch") await t.h.db.prepare("UPDATE normal_inbox_batches SET status='staged',committed_at=NULL WHERE account_id=?").bind(t.id).run();
    if (change === "trash") expect(await t.h.request(`${t.base}/messages/organize`, { method: "POST", cookie: t.alice.cookie,
      headers: { "idempotency-key": crypto.randomUUID() }, body: { messageIds: expect(await t.members(item)).items.map(row => row.id), trashed: true } }));
    gate.release(); const result = await pending; pending = null; assert.ok([401, 404, 409].includes(result.status), result.text);
    for (const table of ["normal_subscription_preferences", "normal_subscription_operations"]) assert.equal(await t.h.db.prepare(`SELECT COUNT(*) n FROM ${table}`).first("n"), 0);
  } finally { gate?.release(); await pending?.catch(() => {}); await t.close(); }
});

test("ordinary subscription CAS races, immutable receipts and batch rollback never overwrite or claim an uncommitted preference", async () => {
  const t = await normalSubscriptionsFixture();
  try {
    await t.receiveAll(); const item = expect(await t.list()).items[0], keys = [crypto.randomUUID(), crypto.randomUUID()];
    const results = await Promise.all(keys.map(key => t.hide(item, true, key))); assert.deepEqual(results.map(row => row.status).sort(), [200, 409]);
    const winner = keys[results.findIndex(row => row.status === 200)]; expect(await t.hide(item, false, winner), 409);
    assert.equal(expect(await t.operation(winner)).operation.version, 1);
    const hidden = expect(await t.list("sources=normal&visibility=hidden")).items[0];
    await t.h.db.prepare("CREATE TRIGGER test_sub_preference_failure BEFORE UPDATE ON normal_subscription_preferences BEGIN SELECT RAISE(ABORT,'synthetic CAS failure'); END").run();
    const failed = crypto.randomUUID(); expect(await t.hide(hidden, false, failed), 503); expect(await t.operation(failed), 404);
    assert.equal(await t.h.db.prepare("SELECT version FROM normal_subscription_preferences").first("version"), 1);
    await t.h.db.prepare("DROP TRIGGER test_sub_preference_failure").run(); expect(await t.hide(hidden, false, failed));
    assert.equal(expect(await t.hide(item, true, winner)).replayed, true); assert.equal(expect(await t.list()).items[0].version, 2);
    const receipt = await t.h.db.prepare("SELECT * FROM normal_subscription_operations WHERE request_key=?").bind(winner).first();
    assert.equal(JSON.stringify(receipt).includes("unsubscribe.example.test"), false); assert.equal(JSON.stringify(receipt).includes("Updates"), false);
  } finally { await t.close(); }
});

test("ordinary subscription sync and repair are atomic with search/graph/checkpoint and five-object repair is resumable", async () => {
  const messages = new Map(Array.from({ length: 7 }, (_, i) => [i + 1, normalListMail(i + 1)])); const t = await normalSubscriptionsFixture({ messages });
  try {
    await t.h.db.prepare("CREATE TRIGGER test_sub_sync_failure BEFORE INSERT ON normal_message_subscriptions BEGIN SELECT RAISE(ABORT,'synthetic subscription failure'); END").run();
    assert.equal((await t.receive()).body.request.state, "failed");
    for (const table of ["normal_inbox_messages", "normal_inbox_search", "normal_thread_links", "normal_message_subscriptions"]) assert.equal(await t.h.db.prepare(`SELECT COUNT(*) n FROM ${table}`).first("n"), 0);
    assert.equal((await t.state()).version, 0); await t.h.db.prepare("DROP TRIGGER test_sub_sync_failure").run(); await t.receiveAll();
    await unindex(t); await t.h.db.prepare("CREATE TRIGGER test_sub_repair_failure BEFORE INSERT ON normal_message_subscriptions BEGIN SELECT RAISE(ABORT,'synthetic repair failure'); END").run();
    expect(await t.list(), 500); assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_search").first("n"), 0);
    await t.h.db.prepare("DROP TRIGGER test_sub_repair_failure").run();
    assert.equal(expect(await t.list(), 409).error.code, "normal_subscription_index_pending");
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_message_subscriptions").first("n"), 5);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_search").first("n"), 5);
    assert.equal(expect(await t.list()).items[0].messageCount, 7); assert.equal(t.opens.length, 4);
  } finally { await t.close(); }
});

for (const change of ["revision", "source", "delete", "user", "epoch"]) test(`late ordinary subscription repair cannot persist or disclose after ${change} changes`, async () => {
  const t = await normalSubscriptionsFixture(); let gate, pending;
  try {
    await t.receiveAll(); const oldEpoch = (await t.state()).epoch_id; await unindex(t); gate = t.holdPut("/get"); pending = t.list(); await gate.entered;
    if (change === "revision") expect(await t.save({ displayName: "Updated" }, 1));
    if (change === "source") expect(await t.save({ username: "new-source" }, 1));
    if (change === "delete") expect(await t.h.request(t.base, { method: "DELETE", cookie: t.alice.cookie, headers: { "idempotency-key": crypto.randomUUID() }, body: { expectedRevision: 1 } }));
    if (change === "user") await t.h.db.prepare("UPDATE users SET status='disabled' WHERE id=?").bind(t.alice.id).run();
    if (change === "epoch") { t.scenario({ validity: "43", messages: t.sourceMessages, uidNext: 4 }); await t.receiveAll(); }
    gate.release(); const result = await pending; pending = null; assert.ok([401, 404, 409].includes(result.status), result.text); assert.equal(result.text.includes("Updates"), false);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_message_subscriptions WHERE epoch_id=?").bind(oldEpoch).first("n"), 0);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_search p JOIN normal_inbox_messages m ON m.id=p.message_id WHERE m.epoch_id=?").bind(oldEpoch).first("n"), 0);
  } finally { gate?.release(); if (pending) await pending; await t.close(); }
});

test("ordinary subscription stored header validation fails closed and legacy missing evidence freezes an unknown negative index", async () => {
  const t = await normalSubscriptionsFixture();
  try {
    await t.receiveAll(); const row = await t.h.db.prepare("SELECT * FROM normal_inbox_messages WHERE uid=1").first(), bucket = await t.h.bucket("INBOX");
    const original = JSON.parse(await (await bucket.get(row.content_key)).text());
    const replace = async content => { await unindex(t); const bytes = Buffer.from(JSON.stringify(content)), digest = createHash("sha256").update(bytes).digest("hex");
      await bucket.put(row.content_key, bytes); await t.h.db.prepare("UPDATE normal_inbox_messages SET content_sha256=?,content_bytes=? WHERE id=?").bind(digest, bytes.length, row.id).run(); };
    for (const subscriptionHeaders of [null, [], { ...original.subscriptionHeaders, listId: 42 }, { ...original.subscriptionHeaders, limited: "false" },
      { ...original.subscriptionHeaders, unsubscribe: "x".repeat(8193) }, { ...original.subscriptionHeaders, listId: "bad\u0000header" }]) {
      await replace({ ...original, subscriptionHeaders }); expect(await t.list(), 503); assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_message_subscriptions").first("n"), 0);
    }
    const legacy = { ...original }; delete legacy.subscriptionHeaders; await replace(legacy); expect(await t.list());
    assert.deepEqual(await t.h.db.prepare("SELECT subscription_key,evidence_present FROM normal_message_subscriptions WHERE message_id=?").bind(row.id).first(), { subscription_key: null, evidence_present: 0 });
    assert.equal(await t.h.db.prepare("SELECT evidence_present FROM normal_message_subscriptions ns JOIN normal_inbox_messages m ON m.id=ns.message_id WHERE uid=3").first("evidence_present"), 1);
    const before = (await t.h.db.prepare("SELECT * FROM normal_message_subscriptions").all()).results; expect(await t.list()); assert.deepEqual((await t.h.db.prepare("SELECT * FROM normal_message_subscriptions").all()).results, before);
    assert.equal(t.opens.length, 1);
  } finally { await t.close(); }
});
