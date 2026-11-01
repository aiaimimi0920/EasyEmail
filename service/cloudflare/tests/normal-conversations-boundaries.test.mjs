import assert from "node:assert/strict";
import { test } from "node:test";
import { normalConversationFixture, expect } from "./normal-conversations-fixture.mjs";
import { newKey, seedMailbox } from "./runtime-harness.mjs";
import { putLabel, labelBody } from "./labels-fixture.mjs";
import { putFolder, folderBody } from "./folders-fixture.mjs";

const organize = (t, ids, patch) => t.h.request(`${t.base}/messages/organize`, { method: "POST", cookie: t.alice.cookie,
  headers: { "idempotency-key": crypto.randomUUID() }, body: { messageIds: ids, ...patch } });

test("explicit conversation sources require ordinary scopes and mixed same-ID/time pagination never merges sources", async () => {
  const t = await normalConversationFixture();
  try {
    await t.receiveAll(); const row = await t.h.db.prepare("SELECT * FROM normal_inbox_messages ORDER BY id DESC LIMIT 1").first();
    const box = await seedMailbox(t.h, t.alice.id, "collision@example.test");
    await t.h.db.prepare(`INSERT INTO messages(id,user_id,mailbox_id,remote_id,fingerprint,sender,recipient,subject,text_body,html_body,attachments,received_at,observed_at)
      VALUES (?,?,?,'same','same','sender@example.test','collision@example.test','Temporary','','','[]',?,?)`)
      .bind(row.id, t.alice.id, box, row.received_at, row.received_at).run();
    const key = await newKey(t.h, t.alice.cookie, { scopes: ["messages:read"] }), limited = { cookie: undefined, token: key.token, origin: null };
    expect(await t.list("folder=all", limited)); expect(await t.list("sources=temporary&folder=all", limited));
    expect(await t.list("sources=normal", limited), 403); expect(await t.list("sources=all", limited), 403);
    const full = await newKey(t.h, t.alice.cookie, { scopes: ["messages:read", "mail-accounts:read"] });
    assert.equal(expect(await t.list("sources=normal&folder=all", { cookie: undefined, token: full.token, origin: null })).items.length, 2);
    const items = []; let cursor = "";
    do { const page = expect(await t.list(`sources=all&folder=all&limit=1${cursor ? `&cursor=${cursor}` : ""}`));
      items.push(...page.items); cursor = page.nextCursor; } while (cursor);
    assert.equal(items.length, 3); assert.deepEqual(items.map(item => item.sourceKind), ["temporary", "normal", "normal"]);
    assert.equal(items.filter(item => item.id === row.id).length, 2, "identical source IDs must remain distinct list entries");
    for (const item of items) {
      const query = item.sourceKind === "normal" ? `sources=normal&accountId=${t.id}&folder=all` : "sources=temporary&folder=all";
      assert.ok(expect(await t.members(item.id, query)).items.every(member => member.sourceKind === item.sourceKind));
    }
    const page = expect(await t.list("sources=all&folder=all&limit=1"));
    expect(await t.list(`sources=normal&folder=all&limit=1&cursor=${page.nextCursor}`), 400);
    assert.equal((await t.h.request(`/api/v1/messages?sources=all&folder=all&limit=1&cursor=${page.nextCursor}`, { cookie: t.alice.cookie })).status, 400);
    const legacy = expect(await t.list("folder=all")); assert.equal(legacy.items.length, 1); assert.equal(legacy.items[0].sourceKind, undefined);
    const legacyCursor = expect(await t.list("sources=all&folder=all&limit=1")).nextCursor;
    expect(await t.list(`folder=all&limit=1&cursor=${legacyCursor}`), 400);
    const group = expect(await t.list("sources=normal&folder=all&q=Needle")).items[0];
    const memberQuery = `sources=normal&accountId=${t.id}&folder=all&limit=1`;
    const memberFirst = expect(await t.members(group.id, memberQuery)), memberNext = expect(await t.members(group.id, `${memberQuery}&cursor=${memberFirst.nextCursor}`));
    assert.equal(new Set([...memberFirst.items, ...memberNext.items].map(item => item.id)).size, 2); assert.equal(memberNext.nextCursor, null);
    expect(await t.list(`sources=normal&accountId=${t.id}&folder=all&limit=1&cursor=${memberFirst.nextCursor}`), 400);
    expect(await t.members(crypto.randomUUID(), `${memberQuery}&cursor=${memberFirst.nextCursor}`), 400);
    expect(await t.members(row.id, "sources=normal"), 400); expect(await t.members(row.id, "sources=all"), 400);
    const bob = await t.h.register("normal-conversation-bob"); expect(await t.list("sources=all", { cookie: bob.cookie }));
    assert.equal(expect(await t.list("sources=all", { cookie: bob.cookie })).items.length, 0);
    expect(await t.members(row.id, undefined, { cookie: bob.cookie }), 404);
    assert.equal(t.opens.length, 1);
  } finally { await t.close(); }
});

test("matching member selects its complete location group, while labels, folders and trash constrain every member", async () => {
  const t = await normalConversationFixture();
  try {
    await t.receiveAll(); const group = expect(await t.list("sources=normal&folder=all&q=Needle")).items[0];
    const rows = expect(await t.members(group.id)).items, needle = rows.find(row => row.subject === "Needle child"), parent = rows.find(row => row.subject === "Late parent");
    const label = crypto.randomUUID(), folder = crypto.randomUUID();
    expect(await putLabel(t.h, t.alice, label, labelBody("Conversation label")), 201);
    expect(await putFolder(t.h, t.alice, folder, folderBody("Conversation folder")), 201);
    expect(await organize(t, [needle.id], { isRead: true, starred: true, addLabelIds: [label], folderId: folder }));
    const flags = expect(await t.list("sources=normal&folder=all&q=Needle&isRead=true&starred=true"));
    assert.equal(flags.items[0].messageCount, 2); assert.equal(flags.items[0].unreadCount, 1); assert.equal(flags.items[0].starred, true);
    assert.equal(expect(await t.members(group.id, `sources=normal&accountId=${t.id}&folder=all&q=Needle&isRead=true`)).items.length, 2);
    const restricted = `sources=normal&folder=all&labelId=${label}&folderId=${folder}`;
    assert.equal(expect(await t.list(restricted)).items[0].messageCount, 1);
    assert.deepEqual(expect(await t.members(needle.id, `${restricted}&accountId=${t.id}`)).items.map(row => row.id), [needle.id]);
    expect(await t.members(parent.id, `${restricted}&accountId=${t.id}`), 404);
    expect(await organize(t, [needle.id], { trashed: true }));
    assert.equal(expect(await t.list("sources=normal&folder=all&q=Needle")).items.length, 0);
    assert.deepEqual(expect(await t.members(needle.id, `sources=normal&accountId=${t.id}&folder=trash`)).items.map(row => row.id), [needle.id]);
    expect(await t.members(parent.id, `sources=normal&accountId=${t.id}&folder=trash`), 404);
    expect(await organize(t, [needle.id], { trashed: false, folderId: null }));
    assert.equal(expect(await t.list("sources=normal&folder=inbox&q=Needle")).items[0].messageCount, 2);
    assert.equal(t.calls.some(line => /STORE|EXPUNGE|COPY|MOVE/.test(line)), false);
  } finally { await t.close(); }
});

test("ordinary graph and cursors remain account/epoch scoped, disabled cache is readable, source changes and deletion hide old graphs", async () => {
  const t = await normalConversationFixture();
  try {
    await t.receiveAll(); const old = expect(await t.list("sources=normal&folder=all&limit=1")), oldEpoch = old.items[0].epochId;
    const second = crypto.randomUUID(); expect(await t.save({ emailAddress: "second@example.test" }, 0, t.alice.cookie, second), 201);
    const received = await t.h.request(`/api/v1/normal-accounts/${second}/sync`, { method: "POST", cookie: t.alice.cookie,
      headers: { "idempotency-key": crypto.randomUUID() }, body: { expectedRevision: 1 } });
    assert.equal(received.body.request.state, "committed", received.text);
    assert.equal(expect(await t.list()).items.length, 4);
    expect(await t.members(old.items[0].id, `sources=normal&accountId=${second}&folder=all`), 404);
    expect(await t.save({ enabled: false }, 1)); assert.equal(expect(await t.list(`sources=normal&accountId=${t.id}&folder=all`)).items.length, 2);
    expect(await t.save({ enabled: true }, 2));
    t.scenario({ validity: "43", messages: t.messages, uidNext: 4 }); assert.equal((await t.receive(undefined, 3)).body.request.state, "committed");
    const current = expect(await t.list(`sources=normal&accountId=${t.id}&folder=all`)); assert.equal(current.items.length, 2);
    assert.ok(current.items.every(item => item.epochId !== oldEpoch)); expect(await t.members(old.items[0].id), 404);
    expect(await t.list(`sources=normal&folder=all&limit=1&cursor=${old.nextCursor}`), 400);
    expect(await t.save({ username: "changed-source" }, 3)); assert.equal(expect(await t.list(`sources=normal&accountId=${t.id}`)).items.length, 0);
    expect(await t.h.request(t.base, { method: "DELETE", cookie: t.alice.cookie, headers: { "idempotency-key": crypto.randomUUID() }, body: { expectedRevision: 4 } }));
    expect(await t.list(`sources=normal&accountId=${t.id}`), 404);
    assert.ok(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_thread_links WHERE account_id=?").bind(t.id).first("n") > 0, "soft delete hides, not physical purge");
    assert.equal(expect(await t.list()).items.length, 2);
  } finally { await t.close(); }
});
