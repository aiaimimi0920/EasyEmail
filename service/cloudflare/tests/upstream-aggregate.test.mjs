import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createHarness, newKey } from "./runtime-harness.mjs";
import { allocate } from "./provider-fixture.mjs";
import { upstreamFixture, mime } from "./upstream-fixture.mjs";
import { attachmentMail, binaryRequest, downloadPath } from "./attachment-fixture.mjs";

let f, h, alice, bob;
before(async () => {
  f = await upstreamFixture({ ENABLE_MAIL_GZIP: "true", E2E_TEST_MODE: "false" }); h = await createHarness(f.bindings);
  alice = await h.register("complete-upstream-alice"); bob = await h.register("complete-upstream-bob");
}, { timeout: 120000 });
beforeEach(async () => { await h.resetLimits(); });
after(async () => { try { await h?.close(); } finally { await f?.close(); } }, { timeout: 20000 });
const request = (route, options = {}) => h.request(route, { cookie: alice.cookie, ...options });
const sync = (box) => request(`/api/v1/mailboxes/${box.id}/sync`, { method: "POST", body: {} });
const list = (box) => request(`/api/v1/mailboxes/${box.id}/messages`);

test("two complete Workers create, receive real MIME, sync, extract and preserve independent API access after restart", async () => {
  const created = await allocate(h, alice.cookie); assert.equal(created.status, 201, created.text);
  const box = created.body.mailbox;
  assert.ok(await f.db.prepare("SELECT id FROM address WHERE name=?").bind(box.address).first());
  assert.equal((await f.deliver(box.address, mime(box.address, "839517"))).rejectReason, undefined);
  const result = await sync(box); assert.equal(result.status, 200, result.text); assert.equal(result.body.sync.inserted, 1);
  assert.equal((await sync(box)).body.sync.inserted, 0);
  const message = (await list(box)).body.items[0];
  const detail = await request(`/api/v1/mailboxes/${box.id}/messages/${message.id}`);
  assert.match(detail.body.message.textBody, /839517/);
  const extraction = await request(`/api/v1/mailboxes/${box.id}/extractions?since=1&sender=noreply&subject=verify`);
  assert.equal(extraction.body.items[0].otp.code, "839517", extraction.text);
  assert.equal((await request(`/api/v1/mailboxes/${box.id}/messages`, { cookie: bob.cookie })).status, 404);
  const reader = await newKey(h, alice.cookie, { scopes: ["messages:read"] });
  assert.equal((await request(`/api/v1/mailboxes/${box.id}/messages`, { token: reader.token, origin: null })).status, 200);
  await h.restart(); assert.equal((await list(box)).body.items[0].id, message.id);
});

test("two complete Workers verify binary attachment bytes from actual compressed upstream MIME", async () => {
  const box = (await allocate(h, alice.cookie)).body.mailbox;
  const fixture = attachmentMail(box.address, Buffer.from([0, 255, 128, 33, 10, 13, 65, 0]));
  const raw = `Message-ID: <${crypto.randomUUID()}@example.test>\r\n${fixture.raw.raw}`;
  assert.equal((await f.deliver(box.address, raw)).rejectReason, undefined);
  assert.equal((await sync(box)).status, 200);
  const message = (await list(box)).body.items[0];
  const detail = await request(`/api/v1/mailboxes/${box.id}/messages/${message.id}`);
  assert.equal(detail.body.message.attachments[0].downloadAvailable, true, detail.text);
  const download = await binaryRequest(h, downloadPath(box, message), alice.cookie);
  assert.equal(download.status, 200, download.bytes.toString()); assert.deepEqual(download.bytes, fixture.bytes);
  assert.equal(download.headers.get("cache-control"), "no-store");
  assert.equal((await binaryRequest(h, downloadPath(box, message), bob.cookie)).status, 404);
});

test("two complete Workers support exact custom names, versioned message deletion and durable mailbox deletion", async () => {
  const name = `exact${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const created = await allocate(h, alice.cookie, "self", { body: { providerId: "self", domain: "cf.example.test", prefix: name } });
  assert.equal(created.status, 201, created.text); const box = created.body.mailbox;
  assert.equal(box.address, `${name}@cf.example.test`);
  assert.equal((await f.deliver(box.address)).rejectReason, undefined); assert.equal((await sync(box)).status, 200);
  const message = (await list(box)).body.items[0], route = `/api/v1/mailboxes/${box.id}/messages/${message.id}`;
  assert.equal((await request(route, { method: "DELETE" })).status, 200);
  const deletion = await request(`${route}/remote-delete`, { method: "POST", headers: { "idempotency-key": crypto.randomUUID() },
    body: { confirmAddress: box.address, confirmMessageId: message.id } });
  assert.equal(deletion.body.deletion.state, "deleted", deletion.text);
  assert.equal(await f.db.prepare("SELECT id FROM raw_mails WHERE address=?").bind(box.address).first(), null);
  const mailboxRoute = `/api/v1/mailboxes/${box.id}/remote-delete`, key = crypto.randomUUID();
  const options = { method: "POST", headers: { "idempotency-key": key }, body: { confirmAddress: box.address, confirmMailboxId: box.id } };
  const removed = await request(mailboxRoute, options); assert.equal(removed.status, 200, removed.text);
  assert.equal(removed.body.deletion.state, "deleted"); assert.equal(removed.body.deletion.externalResourcesDeleted, false);
  assert.equal(await f.db.prepare("SELECT id FROM address WHERE name=?").bind(box.address).first(), null);
  await h.restart(); assert.deepEqual((await request(mailboxRoute, options)).body, removed.body);
  assert.equal(await f.db.prepare("SELECT COUNT(*) n FROM address_delete_operations WHERE address=?").bind(box.address).first("n"), 1);
  const cache = await h.db.prepare("SELECT id FROM messages WHERE id=?").bind(message.id).first(); assert.ok(cache);
});

test("two complete Workers preserve folded RFC references and join a late MIME parent without subject/sender heuristics", async () => {
  const box = (await allocate(h, alice.cookie)).body.mailbox;
  const tag = crypto.randomUUID();
  const childId = `<child-${tag}@example.test>`, rootId = `<parent-${tag}@example.test>`, olderId = `<older-${tag}@example.test>`;
  const message = (id, subject, sender, headers = []) => [`From: ${sender}`, `To: ${box.address}`, `Subject: ${subject}`,
    `Message-ID: ${id}`, ...headers, "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "", "Real MIME thread fixture", ""].join("\r\n");
  assert.equal((await f.deliver(box.address, message(childId, "Child subject", "child@example.test",
    [`In-Reply-To: ${rootId}`, `References: ${olderId}\r\n\t${rootId}`]))).rejectReason, undefined);
  assert.equal((await sync(box)).status, 200);
  const child = (await list(box)).body.items[0];
  assert.equal((await f.deliver(box.address, message(rootId, "Unrelated subject", "parent@example.test"))).rejectReason, undefined);
  assert.equal((await sync(box)).status, 200);
  const result = await request(`/api/v1/conversations?folder=all&mailboxId=${box.id}`);
  assert.equal(result.status, 200, result.text); assert.equal(result.body.items.length, 1);
  assert.equal(result.body.items[0].basis, "headers"); assert.equal(result.body.items[0].messageCount, 2); assert.equal(result.body.items[0].limited, false);
  const links = (await h.db.prepare("SELECT token FROM message_thread_links WHERE message_id=?").bind(child.id).all()).results;
  assert.equal(links.length, 3, "Own ID, unfolded parent and older reference survive actual parsed API");
  await h.restart();
  const members = await request(`/api/v1/conversations/${child.id}/messages?folder=all&mailboxId=${box.id}`);
  assert.equal(members.status, 200, members.text); assert.equal(members.body.items.length, 2);
  assert.equal((await request(`/api/v1/conversations/${child.id}/messages?folder=all`, { cookie: bob.cookie })).status, 404);
});

test("two complete Workers preserve actual folded list headers, private hiding and bounded explicit unsubscribe methods", async () => {
  const box = (await allocate(h, alice.cookie)).body.mailbox;
  const tag = crypto.randomUUID(), listId = `updates-${tag}.example.test`;
  const raw = sender => [`From: ${sender}`, `To: ${box.address}`, "Subject: Actual MIME newsletter",
    `Message-ID: <${crypto.randomUUID()}@example.test>`, `List-ID: Updates <${listId}>`,
    "List-Unsubscribe: <https://unsubscribe.example.test/remove>,\r\n\t<mailto:leave@example.test?subject=unsubscribe>",
    "List-Unsubscribe-Post: List-Unsubscribe=One-Click", "Precedence: bulk", "X-Private: must-not-be-forwarded",
    "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "", "Real MIME subscription fixture", ""].join("\r\n");
  for (const sender of ["first@example.test", "second@example.test"]) assert.equal((await f.deliver(box.address, raw(sender))).rejectReason, undefined);
  assert.equal((await sync(box)).status, 200);
  const result = await request(`/api/v1/subscriptions?mailboxId=${box.id}`); assert.equal(result.status, 200, result.text);
  assert.equal(result.body.items.length, 1); const item = result.body.items[0]; assert.equal(item.messageCount, 2); assert.equal(item.listId, listId);
  assert.equal(item.limited, false); assert.deepEqual(item.methods, ["https://unsubscribe.example.test/remove", "mailto:leave@example.test?subject=unsubscribe"]);
  assert.ok(!result.text.includes("must-not-be-forwarded"));
  const route = `/api/v1/subscriptions/${box.id}/${item.id}`, key = crypto.randomUUID();
  const hidden = await request(route, { method: "PATCH", headers: { "idempotency-key": key }, body: { expectedVersion: 0, hidden: true } });
  assert.equal(hidden.status, 200, hidden.text); assert.equal(hidden.body.operation.requestKey, key);
  assert.equal((await request(`/api/v1/subscriptions?mailboxId=${box.id}`)).body.items.length, 0);
  assert.equal((await request(`${route}/messages?visibility=hidden`)).body.items.length, 2);
  assert.equal((await request(`${route}/messages?visibility=all`, { cookie: bob.cookie })).status, 404);
  await h.restart(); assert.equal((await request(`/api/v1/subscriptions?mailboxId=${box.id}&visibility=hidden`)).body.items[0].version, 1);
  assert.equal(await f.db.prepare("SELECT COUNT(*) n FROM raw_mails WHERE address=?").bind(box.address).first("n"), 2, "Hiding never deletes or unsubscribes upstream");
});
