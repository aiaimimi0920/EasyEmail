import assert from "node:assert/strict";
import { test } from "node:test";
import { mailboxData, normalFolderInboxFixture } from "./normal-folder-inbox-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";

test("two server folders with identical UIDVALIDITY and UID retain independent mail, cursor and durable read access", async () => {
  const t = await normalFolderInboxFixture();
  try {
    const sent = await t.receive("Sent"), archive = await t.receive("&Ti1lhw-");
    assert.equal(sent.status, 200, sent.text); assert.equal(sent.body.request.state, "committed", sent.text);
    assert.equal(archive.body.request.state, "committed", archive.text);
    const a = (await t.messages("Sent")).body, b = (await t.messages("&Ti1lhw-")).body;
    assert.equal(a.items[0].uid, 2); assert.equal(b.items[0].uid, 2); assert.notEqual(a.epochId, b.epochId);
    assert.notEqual(a.items[0].id, b.items[0].id); assert.equal(a.items[0].serverFolderId, t.folder("Sent").id);
    assert.equal(a.items[0].recipient, "bob@example.test"); assert.equal(b.items[0].subject, "Archive mail");
    const path = `${t.folderPath("Sent")}/messages/${a.items[0].id}`;
    assert.equal((await t.request(path)).body.message.textBody.trim(), "Sent mail body");
    const raw = await fetch(new URL(`${path}/raw`, t.h.baseUrl), { headers: { cookie: t.alice.cookie } });
    assert.equal(raw.status, 200); assert.match(await raw.text(), /Sent mail body/);
    assert.equal((await t.request(`${t.folderPath("&Ti1lhw-")}/messages/${a.items[0].id}`)).status, 404);
    assert.equal((await t.request(`${t.base}/messages/${a.items[0].id}`)).status, 404);
    assert.equal((await t.request(`${t.base}/messages`)).body.items.length, 0);
    await t.h.restart(); assert.deepEqual((await t.messages("Sent")).body, a);
    assert.equal(t.calls.some(line => / SELECT | STORE | MOVE | EXPUNGE/.test(line)), false);
    assert.equal((await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_state").first()).n, 0);
  } finally { await t.close(); }
});
test("folder-specific epoch reset and replay never move a different folder checkpoint", async () => {
  const t = await normalFolderInboxFixture();
  try {
    const key = crypto.randomUUID(); await t.receive("Sent", key); await t.receive("&Ti1lhw-");
    const before = (await t.messages("Sent")).body, other = (await t.messages("&Ti1lhw-")).body;
    const opens = t.opens.length; assert.equal((await t.receive("Sent", key)).body.request.state, "committed"); assert.equal(t.opens.length, opens);
    assert.equal((await t.receive("&Ti1lhw-", key)).status, 409);
    const data = mailboxData(); data.get("Sent").validity = "43"; t.scenario({ mailboxes: data });
    assert.equal((await t.receive("Sent")).body.request.result.reset, true);
    assert.notEqual((await t.messages("Sent")).body.epochId, before.epochId);
    assert.equal((await t.request(`${t.folderPath("Sent")}/messages/${before.items[0].id}`)).status, 404);
    assert.deepEqual((await t.messages("&Ti1lhw-")).body, other);
    assert.deepEqual((await t.h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await t.close(); }
});
test("nonselectable folders, foreign owners and missing receive scopes are rejected before connection", async () => {
  const t = await normalFolderInboxFixture();
  try {
    const opens = t.opens.length;
    assert.equal((await t.receive("Container")).status, 409);
    const read = await newKey(t.h, t.alice.cookie, { scopes: ["mail-accounts:read", "messages:read"] });
    assert.equal((await t.messages("Sent", "", { cookie: undefined, token: read.token })).status, 200);
    assert.equal((await t.receive("Sent", crypto.randomUUID(), { cookie: undefined, token: read.token })).status, 403);
    const bob = await t.h.register("folder-inbox-foreign"); assert.equal((await t.messages("Sent", "", { cookie: bob.cookie })).status, 404);
    assert.equal(t.opens.length, opens);
  } finally { await t.close(); }
});

test("folder cursors, attachments and cached reads remain scoped, including while account connections are disabled", async () => {
  const data = mailboxData(), mime = new TextEncoder().encode("From: Alice <alice@example.test>\r\nTo: bob@example.test\r\nSubject: File mail\r\nContent-Type: multipart/mixed; boundary=fixture\r\n\r\n--fixture\r\nContent-Type: text/plain\r\n\r\nBody with file\r\n--fixture\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=file.txt\r\nContent-Transfer-Encoding: base64\r\n\r\nSGVsbG8=\r\n--fixture--\r\n");
  data.get("Sent").messages = new Map([[2, mime], [3, mime]]);
  const t = await normalFolderInboxFixture({ mailboxes: data });
  try {
    await t.receive("Sent"); const first = (await t.messages("Sent", "?limit=1")).body;
    assert.equal(first.items.length, 1); assert.ok(first.nextCursor);
    assert.equal((await t.messages("Sent", `?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`)).body.items[0].uid, 2);
    assert.equal((await t.messages("&Ti1lhw-", `?cursor=${encodeURIComponent(first.nextCursor)}`)).status, 400);
    const item = first.items[0], filePath = `${t.folderPath("Sent")}/messages/${item.id}/attachments/0`;
    const file = await fetch(new URL(filePath, t.h.baseUrl), { headers: { cookie: t.alice.cookie } });
    assert.equal(file.status, 200); assert.equal(await file.text(), "Hello");
    assert.equal((await t.request(`${t.folderPath("&Ti1lhw-")}/messages/${item.id}/attachments/0`)).status, 404);
    const opens = t.opens.length; assert.equal((await t.save({ enabled: false }, 1)).status, 200);
    assert.equal((await t.request(`${t.folderPath("Sent")}/messages/${item.id}`)).status, 200);
    assert.equal(t.opens.length, opens);
  } finally { await t.close(); }
});
