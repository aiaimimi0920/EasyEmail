import assert from "node:assert/strict";
import { test } from "node:test";
import { normalAccessFixture } from "./normal-access-fixture.mjs";
import { newKey, seedMailbox } from "./runtime-harness.mjs";

const path = t => `${t.base}/messages/organize`;
const organize = (t, messageIds, patch, key = crypto.randomUUID(), extra = {}) => t.h.request(path(t), {
  method: "POST", cookie: t.alice.cookie, headers: { "idempotency-key": key }, body: { messageIds, ...patch }, ...extra,
});
const timeline = (t, query = "") => t.h.request(`/api/v1/messages?sources=normal${query}`, { cookie: t.alice.cookie });

test("normal platform flags are independent, immutable-key replay cannot undo later edits and no IMAP writes occur", async () => {
  const t = await normalAccessFixture();
  try {
    await t.receive(); const message = (await t.messages()).body.items[0], before = await t.state();
    assert.deepEqual(message.platformState, { isRead: false, starred: false, archived: false, trashedAt: null });
    assert.ok(message.remoteFlags.includes("\\Seen"), "remote Seen does not initialize the platform read flag");
    const key = crypto.randomUUID(), result = await organize(t, [message.id], { isRead: true, starred: true }, key);
    assert.equal(result.status, 200, result.text); assert.equal(result.body.replayed, false);
    assert.equal((await timeline(t, "&isRead=true&starred=true")).body.items.length, 1);
    assert.equal((await organize(t, [message.id], { isRead: false, starred: false })).status, 200);
    const replay = await organize(t, [message.id], { isRead: true, starred: true }, key);
    assert.equal(replay.status, 200, replay.text); assert.equal(replay.body.replayed, true);
    assert.equal((await t.message(message.id)).body.message.platformState.isRead, false);
    assert.equal((await organize(t, [message.id], { archived: true }, key)).status, 409);
    await t.h.restart(); assert.equal((await t.message(message.id)).body.message.platformState.starred, false);
    assert.deepEqual(await t.state(), before); assert.equal(t.opens.length, 1);
    assert.equal(t.calls.some(line => /STORE|EXPUNGE|COPY|MOVE/.test(line)), false);
  } finally { await t.close(); }
});

test("normal archive, trash, restore, extraction and bound source-specific folder paging share platform state", async () => {
  const t = await normalAccessFixture();
  try {
    await t.receive(); const rows = (await t.messages()).body.items, first = rows[0], second = rows[1];
    await organize(t, [first.id], { archived: true });
    assert.equal((await timeline(t)).body.items.length, 1); assert.equal((await timeline(t, "&folder=archive")).body.items[0].id, first.id);
    assert.equal((await t.messages("?folder=archive")).body.items[0].id, first.id);
    const page = await t.messages("?folder=all&limit=1"); assert.ok(page.body.nextCursor);
    assert.equal((await t.messages(`?folder=trash&cursor=${encodeURIComponent(page.body.nextCursor)}`)).status, 400);
    await organize(t, rows.map(row => row.id), { trashed: true });
    assert.equal((await timeline(t, "&folder=all")).body.items.length, 0);
    assert.equal((await timeline(t, "&folder=trash")).body.items.length, 2);
    assert.equal((await t.h.request(`${t.base}/extractions?since=1`, { cookie: t.alice.cookie })).body.items.length, 0);
    assert.equal((await t.message(first.id)).status, 200, "trash is reversible, not a content purge");
    await organize(t, [first.id], { trashed: false });
    assert.equal((await timeline(t, "&folder=archive")).body.items[0].id, first.id);
    await organize(t, [first.id], { archived: false });
    assert.equal((await timeline(t)).body.items[0].id, first.id);
    assert.equal((await t.message(second.id)).body.message.platformState.trashedAt !== null, true);
    assert.equal(t.opens.length, 1);
  } finally { await t.close(); }
});

test("normal organization is atomic, owner/account exact, scope and Origin guarded and cannot affect colliding temporary IDs", async () => {
  const t = await normalAccessFixture();
  try {
    await t.receive(); const message = (await t.messages()).body.items[0], bob = await t.h.register("normal-org-bob");
    const box = await seedMailbox(t.h, t.alice.id, "collision@example.test");
    await t.h.db.prepare(`INSERT INTO messages(id,user_id,mailbox_id,remote_id,fingerprint,sender,recipient,subject,text_body,html_body,attachments,observed_at)
      VALUES (?,?,?,'collision','collision','','','','','','[]',1)`).bind(message.id, t.alice.id, box).run();
    assert.equal((await organize(t, [message.id, crypto.randomUUID()], { isRead: true })).status, 409);
    assert.equal((await t.message(message.id)).body.message.platformState.isRead, false);
    assert.equal((await organize(t, [message.id], { isRead: true }, undefined, { cookie: bob.cookie })).status, 404);
    assert.equal((await organize(t, [message.id], { isRead: true }, undefined, { origin: "https://evil.invalid" })).status, 403);
    const flags = await newKey(t.h, t.alice.cookie, { scopes: ["mail-accounts:read", "messages:read", "messages:write"] });
    assert.equal((await organize(t, [message.id], { isRead: true }, undefined, { token: flags.token, cookie: undefined, origin: null })).status, 200);
    assert.equal((await organize(t, [message.id], { trashed: true }, undefined, { token: flags.token, cookie: undefined })).status, 403);
    const old = await newKey(t.h, t.alice.cookie, { scopes: ["messages:read", "messages:write", "messages:delete"] });
    assert.equal((await organize(t, [message.id], { isRead: true }, undefined, { token: old.token, cookie: undefined })).status, 403);
    for (const patch of [{}, { isRead: "true" }, { folderId: "invalid" }, { addLabelIds: ["invalid"] }, { remoteFlags: [] }]) {
      assert.equal((await organize(t, [message.id], patch)).status, 400, JSON.stringify(patch));
    }
    assert.equal(await t.h.db.prepare("SELECT is_read FROM messages WHERE id=?").bind(message.id).first("is_read"), 0);
    assert.equal(t.opens.length, 1);
  } finally { await t.close(); }
});
