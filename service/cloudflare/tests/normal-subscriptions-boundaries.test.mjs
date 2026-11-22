import assert from "node:assert/strict";
import { test } from "node:test";
import { normalSubscriptionsFixture, expect } from "./normal-subscriptions-fixture.mjs";
import { newKey, seedMailbox } from "./runtime-harness.mjs";
import { putLabel, labelBody } from "./labels-fixture.mjs";
import { putFolder, folderBody } from "./folders-fixture.mjs";

test("ordinary subscriptions require explicit scopes, isolate owners, and mixed same-ID/time cursors preserve legacy contracts", async () => {
  const t = await normalSubscriptionsFixture();
  try {
    await t.receiveAll(); const normal = expect(await t.list()).items[0];
    const row = await t.h.db.prepare("SELECT * FROM normal_inbox_messages WHERE id=?").bind(normal.latest.id).first();
    const box = await seedMailbox(t.h, t.alice.id, "subscription-collision@example.test");
    await t.h.db.prepare(`INSERT INTO messages(id,user_id,mailbox_id,remote_id,fingerprint,sender,recipient,subject,text_body,html_body,attachments,received_at,observed_at)
      VALUES (?,?,?,'collision','collision','sender@example.test','subscription-collision@example.test','Temporary','','','[]',?,?)`)
      .bind(row.id, t.alice.id, box, row.received_at, row.received_at).run();
    await t.h.db.prepare("INSERT INTO message_subscriptions VALUES (?,?,?,?,?,?,?,?,?)").bind(t.alice.id, box, row.id, normal.id, "updates.example.test", "Temporary", "sender@example.test", "[]", 0).run();
    const token = async scopes => ({ cookie: undefined, origin: null, token: (await newKey(t.h, t.alice.cookie, { scopes })).token });
    const legacy = await token(["messages:read", "subscriptions:read"]);
    expect(await t.list("", legacy)); expect(await t.list("sources=temporary", legacy));
    expect(await t.list("sources=normal", legacy), 403); expect(await t.list("sources=all", legacy), 403);
    expect(await t.members(normal, "", legacy), 403);
    const read = await token(["messages:read", "subscriptions:read", "mail-accounts:read"]);
    expect(await t.list(undefined, read)); expect(await t.hide(normal, true, crypto.randomUUID(), read), 403);
    const items = []; let cursor = "";
    do { const page = expect(await t.list(`sources=all&limit=1${cursor ? `&cursor=${cursor}` : ""}`)); items.push(...page.items); cursor = page.nextCursor; } while (cursor);
    assert.equal(items.length, 2); assert.deepEqual(items.map(item => item.sourceKind), ["temporary", "normal"]);
    assert.equal(items[0].latest.id, items[1].latest.id); assert.equal(items[0].id, items[1].id);
    const first = expect(await t.list("sources=all&limit=1")); assert.ok(first.nextCursor);
    for (const query of ["sources=normal", "sources=all&visibility=hidden", "", `sources=all&accountId=${t.id}`]) expect(await t.list(`${query}${query ? "&" : ""}limit=1&cursor=${first.nextCursor}`), 400);
    expect(await t.h.request(`/api/v1/messages?sources=all&limit=1&cursor=${first.nextCursor}`, { cookie: t.alice.cookie }), 400);
    const old = expect(await t.list("")).items[0]; assert.equal(old.sourceKind, undefined); assert.equal(old.latest.sourceKind, undefined);
    const members = expect(await t.members(normal, "limit=1")); assert.ok(members.nextCursor);
    expect(await t.members({ ...normal, id: "f".repeat(64) }, `limit=1&cursor=${members.nextCursor}`), 400);
    expect(await t.members(normal, `visibility=all&cursor=${members.nextCursor}`), 400);
    const bob = await t.h.register("normal-subscription-bob"); assert.equal(expect(await t.list("sources=all", { cookie: bob.cookie })).items.length, 0);
    expect(await t.members(normal, "", { cookie: bob.cookie }), 404); expect(await t.hide(normal, true, crypto.randomUUID(), { cookie: bob.cookie }), 404);
    expect(await t.hide(normal, true, crypto.randomUUID(), { origin: "https://foreign.example.test" }), 403);
    for (const query of ["sources=normal&sources=normal", "sources=bad", "sources=normal&visibility=bad", "sources=normal&providerId=test"]) expect(await t.list(query), 400);
    expect(await t.h.request(`/api/v1/normal-subscriptions/${t.id}/${normal.id}/messages`, { cookie: t.alice.cookie }), 400);
    for (const patch of [{ expectedEpochId: { toString: "bad" } }, { expectedEpochId: "-".repeat(36) }, { expectedVersion: -1 }, { hidden: 1 }, { extra: true }]) {
      expect(await t.h.request(`/api/v1/normal-subscriptions/${t.id}/${normal.id}`, { method: "PATCH", cookie: t.alice.cookie,
        headers: { "idempotency-key": crypto.randomUUID() }, body: { expectedEpochId: normal.epochId, expectedVersion: 0, hidden: true, ...patch } }), 400);
    }
    assert.equal(t.opens.length, 1);
  } finally { await t.close(); }
});

test("ordinary subscription labels and folders constrain every member and preferences stay account/epoch private", async () => {
  const t = await normalSubscriptionsFixture();
  try {
    await t.receiveAll(); const item = expect(await t.list()).items[0], members = expect(await t.members(item)).items;
    const label = crypto.randomUUID(), folder = crypto.randomUUID();
    expect(await putLabel(t.h, t.alice, label, labelBody("Subscription label")), 201); expect(await putFolder(t.h, t.alice, folder, folderBody("Subscription folder")), 201);
    expect(await t.h.request(`${t.base}/messages/organize`, { method: "POST", cookie: t.alice.cookie, headers: { "idempotency-key": crypto.randomUUID() },
      body: { messageIds: [members[0].id], addLabelIds: [label], folderId: folder, isRead: true, starred: true } }));
    assert.equal(expect(await t.list("sources=normal&isRead=true&starred=true")).items[0].messageCount, 2);
    assert.equal(expect(await t.list(`sources=normal&labelId=${label}&folderId=${folder}`)).items[0].messageCount, 1);
    assert.deepEqual(expect(await t.members(item, `labelId=${label}&folderId=${folder}`)).items.map(row => row.id), [members[0].id]);
    const key = crypto.randomUUID(); expect(await t.hide(item, true, key));
    const second = crypto.randomUUID(); expect(await t.save({ emailAddress: "second@example.test" }, 0, t.alice.cookie, second), 201);
    expect(await t.h.request(`/api/v1/normal-accounts/${second}/sync`, { method: "POST", cookie: t.alice.cookie, headers: { "idempotency-key": crypto.randomUUID() }, body: { expectedRevision: 1 } }));
    assert.equal(expect(await t.list()).items[0].accountId, second);
    expect(await t.save({ enabled: false }, 1)); assert.equal(expect(await t.list(`sources=normal&accountId=${t.id}&visibility=hidden`)).items.length, 1);
    expect(await t.save({ enabled: true }, 2)); t.scenario({ validity: "43", messages: t.sourceMessages, uidNext: 4 });
    assert.equal((await t.receive(undefined, 3)).body.request.state, "committed");
    const current = expect(await t.list(`sources=normal&accountId=${t.id}`)).items[0]; assert.notEqual(current.epochId, item.epochId); assert.equal(current.version, 0);
    expect(await t.members(item), 409); assert.equal(expect(await t.hide(item, true, key)).replayed, true);
    expect(await t.hide(item, true), 409); assert.equal(expect(await t.list(`sources=normal&accountId=${t.id}`)).items[0].hidden, false);
    assert.equal(expect(await t.operation(key)).operation.epochId, item.epochId);
    expect(await t.save({ username: "changed-source" }, 3)); assert.equal(expect(await t.list(`sources=normal&accountId=${t.id}`)).items.length, 0);
    expect(await t.h.request(t.base, { method: "DELETE", cookie: t.alice.cookie, headers: { "idempotency-key": crypto.randomUUID() }, body: { expectedRevision: 4 } }));
    expect(await t.operation(key), 404); expect(await t.list(`sources=normal&accountId=${t.id}`), 404);
    assert.ok(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_message_subscriptions WHERE account_id=?").bind(t.id).first("n") > 0);
  } finally { await t.close(); }
});

test("ordinary subscription operation capacity rejects new intents but preserves exact historical replay and read-only receipts", async () => {
  const t = await normalSubscriptionsFixture();
  try {
    await t.receiveAll(); const item = expect(await t.list()).items[0], key = crypto.randomUUID(), original = expect(await t.hide(item, true, key));
    await t.h.db.prepare(`WITH RECURSIVE capacity(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM capacity WHERE n<9999)
      INSERT INTO normal_subscription_operations(user_id,request_key,id,request_hash,account_id,account_revision,epoch_id,subscription_key,hidden,version,created_at,completed_at)
      SELECT ?,'capacity-'||n,'capacity-id-'||n,'synthetic',?,1,?,?,1,1,1,1 FROM capacity`).bind(t.alice.id, t.id, item.epochId, item.id).run();
    const hidden = expect(await t.list("sources=normal&visibility=hidden")).items[0], failed = crypto.randomUUID();
    assert.equal(expect(await t.hide(hidden, false, failed), 409).error.code, "normal_subscription_changed_or_limit"); expect(await t.operation(failed), 404);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_subscription_operations").first("n"), 10000);
    assert.deepEqual(expect(await t.hide(item, true, key)).operation, original.operation); assert.equal(expect(await t.operation(key)).operation.version, 1);
    assert.equal(await t.h.db.prepare("SELECT version FROM normal_subscription_preferences").first("version"), 1);
  } finally { await t.close(); }
});
