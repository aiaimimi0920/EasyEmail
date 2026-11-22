import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createHarness, newKey, seedMailbox } from "./runtime-harness.mjs";

let h, alice, bob, a, b, foreign;
const ids = Array.from({ length: 5 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);
const query = (params = {}, extra = {}) => h.request(`/api/v1/messages?${new URLSearchParams(params)}`, { cookie: alice.cookie, ...extra });
before(async () => {
  h = await createHarness(); alice = await h.register("aggregate-alice"); bob = await h.register("aggregate-bob");
  a = await seedMailbox(h, alice.id, "alpha@example.test");
  b = await seedMailbox(h, alice.id, "beta@example.test");
  foreign = await seedMailbox(h, bob.id, "private@example.test");
  for (let i = 0; i < ids.length; i++) {
    const box = i === 4 ? foreign : i % 2 ? b : a;
    await h.db.prepare(`INSERT INTO messages
      (id,user_id,mailbox_id,remote_id,fingerprint,sender,recipient,subject,text_body,html_body,attachments,received_at,observed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'[]',?,?)`)
      .bind(ids[i], i === 4 ? bob.id : alice.id, box, `remote-${i}`, `fingerprint-${i}`,
        i === 1 ? "Unique@sender.test" : "noreply@example.test", box === a ? "alpha@example.test" : "beta@example.test",
        i === 2 ? "Literal 100%_ready" : "Ordinary subject", i === 0 ? "Needle hidden in body" : "ordinary text",
        "<b>HTML search term</b>", i === 3 ? null : 100, i === 3 ? 200 : 100).run();
  }
});
beforeEach(async () => h.resetLimits());
after(async () => h?.close());

test("aggregate inbox uses newest-first keyset pages across owned mailboxes only", async () => {
  const page = await query({ limit: "2" });
  assert.equal(page.status, 200, page.text);
  assert.deepEqual(page.body.items.map((row) => row.id), [ids[3], ids[2]]);
  assert.equal(page.body.items[0].receivedAt, null);
  assert.equal(page.body.items[0].mailboxAddress, "beta@example.test");
  assert.equal(page.body.items[0].providerId, "synthetic-fixture");
  assert.equal(page.body.items[0].isRead, false);
  assert.equal(page.body.items[0].text_body, undefined);
  const next = await query({ limit: "2", cursor: page.body.nextCursor });
  assert.deepEqual(next.body.items.map((row) => row.id), [ids[1], ids[0]]);
  assert.equal(next.body.nextCursor, null);
  assert.equal((await query({ limit: "1", cursor: page.body.nextCursor }, { cookie: bob.cookie })).status, 400);
  assert.equal((await query({ folder: "all", cursor: page.body.nextCursor })).status, 400);
  assert.equal((await query({ q: "different", cursor: page.body.nextCursor })).status, 400);
});

test("aggregate filters search cached content with literal wildcard characters and strict dates", async () => {
  for (const [params, expected] of [
    [{ q: "needle" }, [ids[0]]], [{ q: "100%_" }, [ids[2]]], [{ q: "HTML SEARCH" }, ids.slice(0, 4).reverse()],
    [{ sender: "unique@sender" }, [ids[1]]], [{ recipient: "ALPHA@" }, [ids[2], ids[0]]],
    [{ mailboxId: a }, [ids[2], ids[0]]], [{ providerId: "nonexistent" }, []],
    [{ since: "100", until: "100" }, [ids[2], ids[1], ids[0]]],
  ]) assert.deepEqual((await query(params)).body.items.map((row) => row.id), expected, JSON.stringify(params));
  for (const mailboxId of [foreign, crypto.randomUUID()]) assert.equal((await query({ mailboxId })).status, 404);
  for (const params of [{ folder: "bad" }, { isRead: "1" }, { starred: "yes" }, { limit: "101" },
    { since: "1e2" }, { since: "101", until: "100" }, { cursor: "bad" }, { q: "x".repeat(257) }, { mailboxId: "invalid" }, { userId: bob.id }]) {
    assert.equal((await query(params)).status, 400, JSON.stringify(params));
  }
  assert.equal((await h.request("/api/v1/messages?q=a&q=b", { cookie: alice.cookie })).status, 400);
});

test("aggregate flag filters are platform state, GET is read-only, and message scopes are independent", async () => {
  const writer = await newKey(h, alice.cookie, { scopes: ["messages:write"] });
  const reader = await newKey(h, alice.cookie, { scopes: ["messages:read"] });
  const metadata = await newKey(h, alice.cookie);
  assert.equal((await query({}, { token: metadata.token })).status, 403);
  assert.equal((await query({}, { token: writer.token })).status, 403);
  const patched = await h.request(`/api/v1/mailboxes/${b}/messages/${ids[1]}`, { method: "PATCH", token: writer.token,
    origin: null, body: { isRead: true, starred: true, archived: true } });
  assert.equal(patched.status, 200);
  assert.deepEqual((await query({ folder: "archive", isRead: "true", starred: "true" }, { token: reader.token })).body.items.map((r) => r.id), [ids[1]]);
  assert.equal((await query()).body.items.some((row) => row.id === ids[1]), false);
  const all = await query({ folder: "all" });
  assert.equal(all.body.items.length, 4);
  assert.equal(all.body.items.find((row) => row.id === ids[0]).isRead, false);
  assert.equal((await query({ isRead: "false" })).body.items.length, 3);
  // Config is deliberately absent: all GET queries must still succeed without a provider.
  assert.equal((await query({}, { token: reader.token, origin: null })).status, 200);
});

test("valid pre-epoch receipt times remain traversable in timeline cursors", async () => {
  for (let i = 0; i < 2; i++) {
    await h.db.prepare(`INSERT INTO messages
      (id,user_id,mailbox_id,remote_id,fingerprint,sender,recipient,subject,text_body,html_body,attachments,received_at,observed_at)
      SELECT ?,user_id,mailbox_id,?,? ,sender,recipient,'pre-epoch',text_body,html_body,attachments,-1,observed_at
      FROM messages WHERE id = ?`).bind(crypto.randomUUID(), `old-${i}`, `old-hash-${i}`, ids[0]).run();
  }
  const first = await query({ q: "pre-epoch", limit: "1" });
  assert.equal(first.body.items[0].receivedAt, -1);
  const second = await query({ q: "pre-epoch", limit: "1", cursor: first.body.nextCursor });
  assert.equal(second.status, 200, second.text);
  assert.notEqual(second.body.items[0].id, first.body.items[0].id);
  assert.equal(second.body.nextCursor, null);
});
