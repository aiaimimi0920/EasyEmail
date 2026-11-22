import assert from "node:assert/strict";
import { test } from "node:test";
import { allocate } from "./provider-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";
import { subscriptionsFixture, listMail, listHeaders, sync, subscriptions, subscriptionMembers, hideSubscription, subscriptionPath, expect } from "./subscriptions-fixture.mjs";

test("subscription grouping is mailbox/user isolated, pages whole groups and binds all cursor scopes", async () => {
  const f = await subscriptionsFixture(); const { h, alice, bob, box } = f;
  try {
    const second = expect(await allocate(h, alice.cookie), 201).mailbox, foreign = expect(await allocate(h, bob.cookie), 201).mailbox;
    const rows = Array.from({ length: 28 }, (_, i) => listMail(box, i + 1, { subject: i === 0 ? "Needle" : `Member ${i}`, sender: `sender${i}@example.test` }));
    rows.push(listMail(box, 29, { subscription_headers: listHeaders({ listId: "Other <other.example.test>" }) }));
    f.f.messages.set(box.address, rows); f.f.messages.set(second.address, [listMail(second, 1)]); f.f.messages.set(foreign.address, [listMail(foreign, 1)]);
    for (let p = 1; p <= 3; p++) await sync(f, box, p); await sync(f, second);
    expect(await h.request(`/api/v1/mailboxes/${foreign.id}/sync`, { cookie: bob.cookie, method: "POST", body: {} }));
    const calls = f.f.calls.length, page = expect(await subscriptions(h, alice)); assert.equal(page.items.length, 3);
    const target = page.items.find(i => i.messageCount === 28); assert.ok(target); assert.equal(target.unreadCount, 28);
    const first = expect(await subscriptionMembers(h, alice, target, "limit=25")); assert.equal(first.items.length, 25); assert.ok(first.nextCursor);
    const rest = expect(await subscriptionMembers(h, alice, target, `limit=25&cursor=${first.nextCursor}`));
    assert.equal(rest.items.length, 3); assert.equal(new Set([...first.items, ...rest.items].map(i => i.id)).size, 28);
    const searched = expect(await subscriptions(h, alice, "q=Needle")); assert.equal(searched.items[0].messageCount, 28);
    assert.equal(expect(await subscriptionMembers(h, alice, target, "q=Needle")).items.length, 25);
    expect(await subscriptionMembers(h, alice, target, "q=missing"), 404);
    const cursor = expect(await subscriptions(h, alice, "limit=1")).nextCursor;
    const next = expect(await subscriptions(h, alice, `limit=1&cursor=${cursor}`)); assert.equal(next.items.length, 1);
    expect(await subscriptions(h, bob, `limit=1&cursor=${cursor}`), 400);
    expect(await subscriptions(h, alice, `visibility=all&limit=1&cursor=${cursor}`), 400);
    expect(await subscriptionMembers(h, alice, page.items.find(i => i.id !== target.id), `limit=25&cursor=${first.nextCursor}`), 400);
    expect(await subscriptionMembers(h, bob, target), 404); expect(await subscriptions(h, alice, `mailboxId=${foreign.id}`), 404);
    assert.equal(f.f.calls.length, calls);
  } finally { await f.close(); }
});

test("subscription permissions, origin, routes, visibility and exact request schema fail closed without external writes", async () => {
  const f = await subscriptionsFixture(); const { h, alice, bob, box } = f;
  try {
    f.f.messages.set(box.address, [listMail(box, 1)]); await sync(f); const item = expect(await subscriptions(h, alice)).items[0];
    const reader = await newKey(h, alice.cookie, { scopes: ["messages:read", "subscriptions:read"] });
    const writer = await newKey(h, alice.cookie, { scopes: ["messages:read", "subscriptions:read", "subscriptions:write"] });
    for (const scopes of [["messages:read"], ["subscriptions:read"], ["subscriptions:write"]]) {
      const key = await newKey(h, alice.cookie, { scopes }); expect(await subscriptions(h, alice, "", { token: key.token }), 403);
    }
    expect(await h.request("/api/v1/subscriptions"), 401); expect(await subscriptions(h, alice, "", { token: reader.token, origin: null }));
    expect(await hideSubscription(h, alice, item, true, crypto.randomUUID(), { token: reader.token }), 403);
    expect(await hideSubscription(h, alice, item, true, crypto.randomUUID(), { origin: "https://foreign.example.test" }), 403);
    for (const query of ["extra=x", "visibility=no", "visibility=all&visibility=active", "q=a&q=b", "limit=101", "cursor=broken"]) expect(await subscriptions(h, alice, query), 400);
    for (const body of [{ hidden: true }, { expectedVersion: -1, hidden: true }, { expectedVersion: 0, hidden: "true" }, { expectedVersion: 0, hidden: true, extra: 1 }]) {
      expect(await hideSubscription(h, alice, item, true, crypto.randomUUID(), { body }), 400);
    }
    expect(await hideSubscription(h, alice, item, true, "broken"), 400);
    expect(await subscriptions(h, alice, "", { method: "POST" }), 405);
    expect(await h.request(subscriptionPath(item), { cookie: alice.cookie, method: "DELETE" }), 405);
    const key = crypto.randomUUID(); expect(await hideSubscription(h, alice, item, true, key, { token: writer.token, origin: null }));
    expect(await subscriptionMembers(h, alice, item), 404);
    expect(await subscriptionMembers(h, alice, item, "visibility=hidden"));
    expect(await h.request(`/api/v1/subscription-operations/${key}`, { token: reader.token, origin: null }), 403);
    const receipt = expect(await h.request(`/api/v1/subscription-operations/${key}`, { token: writer.token, origin: null })); assert.equal(receipt.operation.version, 1);
    expect(await h.request(`/api/v1/subscription-operations/${key}`, { cookie: bob.cookie }), 404);
    expect(await hideSubscription(h, alice, item, false, key), 409);
  } finally { await f.close(); }
});

test("list headers, sender fallback and unsubscribe methods are bounded and reject dangerous URL forms", async () => {
  const f = await subscriptionsFixture(); const { h, alice, box } = f;
  try {
    const invalid = ["javascript:alert(1)", "data:text/html,boom", "https://user:pass@example.test/x", "https://example.test/%0d%0aX",
      "mailto:a@example.test,b@example.test", "mailto:a@example.test?cc=other@example.test", "mailto:a@example.test?subject=x%0aBcc:other@example.test"];
    const safe = Array.from({ length: 10 }, (_, i) => `https://unsubscribe.example.test/m${i}`);
    const rows = [listMail(box, 1, { subscription_headers: listHeaders({ unsubscribe: [...invalid, ...safe, safe[0]].map(u => `<${u}>`).join(", ") }) }),
      listMail(box, 2, { sender: "Fallback <fallback@example.test>", subscription_headers: listHeaders({ listId: "", unsubscribe: "", precedence: "bulk" }) }),
      listMail(box, 3, { sender: "Invalid sender", subscription_headers: listHeaders({ listId: "", unsubscribe: "", precedence: "bulk" }) }),
      listMail(box, 4, { subscription_headers: listHeaders({ listId: "", unsubscribe: "", precedence: "", unsubscribePost: "" }) }),
      listMail(box, 5, { subscription_headers: listHeaders({ listId: "x".repeat(9000), unsubscribe: "\r\nInjected: bad" }) })];
    f.f.messages.set(box.address, rows); await sync(f); const page = expect(await subscriptions(h, alice)); assert.equal(page.items.length, 3);
    const main = page.items.find(i => i.listId); assert.equal(main.methods.length, 8); assert.equal(main.limited, true);
    assert.deepEqual(main.methods, safe.slice(0, 8)); assert.ok(page.items.some(i => i.senderAddress === "fallback@example.test"));
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM message_subscriptions WHERE subscription_key IS NULL").first("n"), 2);
    const before = (await h.db.prepare("SELECT * FROM message_subscriptions ORDER BY message_id").all()).results;
    rows[0].subscription_headers = { version: 2 }; expect(await h.request(`/api/v1/mailboxes/${box.id}/sync`, { cookie: alice.cookie, method: "POST", body: {} }), 502);
    assert.deepEqual((await h.db.prepare("SELECT * FROM message_subscriptions ORDER BY message_id").all()).results, before);
  } finally { await f.close(); }
});

test("subscription search is soft but inbox, archive, labels, folders and trash constrain every member", async () => {
  const f = await subscriptionsFixture(); const { h, alice, box } = f;
  try {
    f.f.messages.set(box.address, [listMail(box, 1, { subject: "Needle" }), listMail(box, 2), listMail(box, 3)]); await sync(f);
    const item = expect(await subscriptions(h, alice)).items[0], all = expect(await subscriptionMembers(h, alice, item)).items;
    const id = all.find(i => i.subject === "Needle").id, other = all.find(i => i.subject === "Newsletter 3").id;
    await h.db.prepare("UPDATE messages SET archived=1,is_read=1 WHERE id=?").bind(other).run();
    assert.equal(expect(await subscriptions(h, alice, "folder=inbox&q=Needle")).items[0].messageCount, 2);
    const label = crypto.randomUUID(), folder = crypto.randomUUID();
    await h.db.batch([
      h.db.prepare("INSERT INTO labels(user_id,id,name,name_key,color,revision,created_at,updated_at) VALUES(?,?,?,'scoped','blue',1,unixepoch(),unixepoch())").bind(alice.id, label, "Scoped"),
      h.db.prepare("INSERT INTO message_labels(user_id,message_id,label_id) VALUES(?,?,?)").bind(alice.id, id, label),
      h.db.prepare("INSERT INTO folders(user_id,id,name,name_key,color,revision,created_at,updated_at) VALUES(?,?,?,'scoped','blue',1,unixepoch(),unixepoch())").bind(alice.id, folder, "Scoped"),
      h.db.prepare("INSERT INTO message_folders(user_id,message_id,folder_id) VALUES(?,?,?)").bind(alice.id, id, folder),
    ]);
    for (const query of [`folder=all&labelId=${label}`, `folder=inbox&folderId=${folder}`]) {
      assert.equal(expect(await subscriptions(h, alice, query)).items[0].messageCount, 1);
      assert.deepEqual(expect(await subscriptionMembers(h, alice, item, query)).items.map(m => m.id), [id]);
    }
    expect(await h.request(`/api/v1/mailboxes/${box.id}/messages/${id}`, { cookie: alice.cookie, method: "DELETE" }));
    assert.equal(expect(await subscriptions(h, alice, "q=Needle")).items.length, 0);
    assert.equal(expect(await subscriptions(h, alice, "folder=trash")).items[0].messageCount, 1);
    assert.equal(expect(await subscriptions(h, alice, "folder=archive")).items[0].messageCount, 1);
  } finally { await f.close(); }
});
