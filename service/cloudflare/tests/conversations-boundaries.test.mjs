import assert from "node:assert/strict";
import { test } from "node:test";
import { allocate } from "./provider-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";
import { conversationFixture, threadMail, sync, conversations, members, expect } from "./conversations-fixture.mjs";

test("thread IDs never join users/mailboxes and read scope, routes and cursor fingerprints are enforced", async () => {
  const f = await conversationFixture(); const { h, alice, bob, box } = f;
  try {
    const second = expect(await allocate(h, alice.cookie), 201).mailbox, foreign = expect(await allocate(h, bob.cookie), 201).mailbox;
    for (const b of [box, second, foreign]) f.f.messages.set(b.address, [threadMail(b, 1, "<same@example.test>", "<root@example.test>")]);
    await sync(f); await sync(f, second);
    expect(await h.request(`/api/v1/mailboxes/${foreign.id}/sync`, { cookie: bob.cookie, method: "POST", body: {} }));
    const page = expect(await conversations(h, alice)); assert.equal(page.items.length, 2); assert.ok(page.items.every(item => item.messageCount === 1));
    const anchor = page.items[0].id; expect(await members(h, bob, anchor), 404);
    expect(await conversations(h, alice, `mailboxId=${foreign.id}`), 404); expect(await h.request("/api/v1/conversations"), 401);
    const denied = await newKey(h, alice.cookie), reader = await newKey(h, alice.cookie, { scopes: ["messages:read"] });
    expect(await conversations(h, alice, "", { token: denied.token }), 403);
    expect(await conversations(h, alice, "folder=all", { token: reader.token, origin: null }));
    expect(await conversations(h, alice, "", { method: "POST", token: reader.token }), 405);
    const cursor = expect(await conversations(h, alice, "folder=all&limit=1")).nextCursor; assert.ok(cursor);
    expect(await conversations(h, bob, `folder=all&limit=1&cursor=${cursor}`), 400);
    expect(await conversations(h, alice, `folder=inbox&limit=1&cursor=${cursor}`), 400);
    for (const query of ["q=x&q=y", "folder=invalid", "limit=101", "cursor=broken", "extra=true"]) expect(await conversations(h, alice, query), 400);
    assert.equal(f.f.calls.filter(call => call.method === "POST").length, 3, "Conversation reads must not create or send upstream mail");
  } finally { await f.close(); }
});

test("search/flag matches select a complete location-scoped conversation without exposing trash, purge or other locations", async () => {
  const f = await conversationFixture(); const { h, alice, box } = f;
  try {
    f.f.messages.set(box.address, [threadMail(box, 1, "<a@example.test>", "<root@example.test>", "Needle"),
      threadMail(box, 2, "<b@example.test>", "<root@example.test>", "Newest"), threadMail(box, 3, "<c@example.test>", "<root@example.test>", "Archived")]);
    await sync(f);
    const all = expect(await conversations(h, alice)).items[0], items = expect(await members(h, alice, all.id)).items;
    const id = subject => items.find(item => item.subject === subject).id;
    await h.db.prepare("UPDATE messages SET is_read=1 WHERE id=?").bind(id("Newest")).run();
    await h.db.prepare("UPDATE messages SET archived=1 WHERE id=?").bind(id("Archived")).run();
    const filtered = expect(await conversations(h, alice, "folder=inbox&q=Needle&isRead=false"));
    assert.equal(filtered.items.length, 1); assert.equal(filtered.items[0].messageCount, 2); assert.equal(filtered.items[0].unreadCount, 1);
    assert.equal(filtered.items[0].latest.subject, "Newest");
    assert.equal(expect(await members(h, alice, filtered.items[0].id, "folder=inbox&q=Needle&isRead=false")).items.length, 2);
    expect(await members(h, alice, filtered.items[0].id, "folder=inbox&q=does-not-match"), 404);
    expect(await h.request(`/api/v1/mailboxes/${box.id}/messages/${id("Needle")}`, { cookie: alice.cookie, method: "DELETE" }));
    assert.equal(expect(await conversations(h, alice, "folder=inbox&q=Needle")).items.length, 0);
    assert.equal(expect(await conversations(h, alice, "folder=trash")).items[0].messageCount, 1);
    assert.equal(expect(await conversations(h, alice, "folder=archive")).items[0].messageCount, 1);
    assert.equal(expect(await conversations(h, alice, "folder=all")).items[0].messageCount, 2);
  } finally { await f.close(); }
});

test("bounded invalid/truncated header input cannot introduce raw control data, while absent evidence uses explicit fallback", async () => {
  const f = await conversationFixture(); const { h, alice, box } = f;
  try {
    const rows = [threadMail(box, 1, "<one@example.test>", "<root@example.test>\r\nX: injected"),
      threadMail(box, 2, "<two@example.test>", Array.from({ length: 45 }, (_, i) => `<r${i}@example.test>`).join(" ")),
      { ...threadMail(box, 3, null), sender: "invalid sender", subject: "" }];
    f.f.messages.set(box.address, rows); await sync(f);
    const page = expect(await conversations(h, alice)); assert.equal(page.items.length, 3); assert.equal(page.items.filter(item => item.limited).length, 2);
    assert.equal(page.items.find(item => item.latest.subject === "").basis, "single");
    const links = (await h.db.prepare("SELECT token FROM message_thread_links WHERE mailbox_id=?").bind(box.id).all()).results;
    assert.ok(links.length <= 33); assert.ok(links.every(row => /^[a-f0-9]{64}$/.test(row.token)));
    rows[0].thread_headers = { version: 7, references: [] };
    const bad = await h.request(`/api/v1/mailboxes/${box.id}/sync`, { cookie: alice.cookie, method: "POST", body: {} });
    expect(bad, 502); assert.equal(expect(await conversations(h, alice)).items.length, 3);
  } finally { await f.close(); }
});

test("label/custom-folder scopes constrain every expanded member and member cursors cannot cross anchors or flat lists", async () => {
  const f = await conversationFixture(); const { h, alice, box } = f;
  try {
    f.f.messages.set(box.address, [threadMail(box, 1, "<case@EXAMPLE.TEST>", "", "Root"),
      threadMail(box, 2, "<child@example.test>", "<case@example.test>", "Child"), threadMail(box, 3, "<Case@example.test>", "", "Separate")]);
    await sync(f); const page = expect(await conversations(h, alice)); assert.equal(page.items.length, 2, "Domain folds but Message-ID local-part stays case-sensitive");
    const group = page.items.find(item => item.messageCount === 2), separate = page.items.find(item => item.messageCount === 1);
    const children = expect(await members(h, alice, group.id)).items, id = children.find(item => item.subject === "Root").id;
    const label = crypto.randomUUID(), folder = crypto.randomUUID();
    await h.db.batch([
      h.db.prepare("INSERT INTO labels(user_id,id,name,name_key,color,revision,created_at,updated_at) VALUES(?,?,?,'scoped','blue',1,unixepoch(),unixepoch())").bind(alice.id, label, "Scoped"),
      h.db.prepare("INSERT INTO message_labels(user_id,message_id,label_id) VALUES(?,?,?)").bind(alice.id, id, label),
      h.db.prepare("INSERT INTO folders(user_id,id,name,name_key,color,revision,created_at,updated_at) VALUES(?,?,?,'scoped','blue',1,unixepoch(),unixepoch())").bind(alice.id, folder, "Scoped"),
      h.db.prepare("INSERT INTO message_folders(user_id,message_id,folder_id) VALUES(?,?,?)").bind(alice.id, id, folder),
    ]);
    for (const query of [`folder=all&labelId=${label}`, `folder=inbox&folderId=${folder}`]) {
      const result = expect(await conversations(h, alice, query)); assert.equal(result.items[0].messageCount, 1);
      const scoped = expect(await members(h, alice, id, query)); assert.deepEqual(scoped.items.map(row => row.id), [id]);
    }
    const reader = await newKey(h, alice.cookie, { scopes: ["messages:read"] });
    expect(await conversations(h, alice, `folder=all&labelId=${label}`, { token: reader.token }), 403);
    expect(await conversations(h, alice, `folder=all&folderId=${folder}`, { token: reader.token }), 403);
    const cursor = expect(await members(h, alice, group.id, "folder=all&limit=1")).nextCursor; assert.ok(cursor);
    expect(await members(h, alice, separate.id, `folder=all&limit=1&cursor=${cursor}`), 400);
    expect(await h.request(`/api/v1/messages?folder=all&limit=1&cursor=${cursor}`, { cookie: alice.cookie }), 400);
    const inbox = expect(await conversations(h, alice, "folder=inbox")); assert.ok(inbox.items.every(item => item.messageCount === 1));
  } finally { await f.close(); }
});
