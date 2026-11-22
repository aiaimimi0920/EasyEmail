import assert from "node:assert/strict";
import { test } from "node:test";
import { normalFolderInboxFixture } from "./normal-folder-inbox-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";
import { putFolder, folderBody } from "./folders-fixture.mjs";

test("server INBOX cache ignores platform placement while legacy folder and archive/trash filters remain unchanged", async () => {
  const t = await normalFolderInboxFixture();
  try {
    assert.equal((await t.receive("INBOX")).body.request.state, "committed");
    const id = (await t.messages("INBOX")).body.items[0].id, folderId = crypto.randomUUID();
    assert.equal((await putFolder(t.h, t.alice, folderId, folderBody("平台分类"))).status, 201);
    const organize = patch => t.request(`${t.base}/messages/organize`, { method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() }, body: { messageIds: [id], ...patch } });
    assert.equal((await organize({ folderId })).status, 200);
    const opens = t.opens.length;
    assert.equal((await t.request(`${t.base}/messages?folder=inbox`)).body.items.length, 0);
    assert.equal((await t.request(`${t.base}/messages?folderId=${folderId}`)).body.items[0].id, id);
    assert.deepEqual((await t.messages("INBOX")).body.items.map(row => row.id), [id]);
    assert.equal((await t.request(`${t.folderPath("INBOX")}/messages/${id}`)).status, 200);
    assert.equal((await organize({ archived: true })).status, 200);
    assert.equal((await t.request(`${t.base}/messages?folder=archive`)).body.items[0].id, id);
    assert.deepEqual((await t.messages("INBOX")).body.items.map(row => row.id), [id]);
    assert.equal((await organize({ trashed: true })).status, 200);
    assert.equal((await t.request(`${t.base}/messages?folder=trash`)).body.items[0].id, id);
    assert.deepEqual((await t.messages("INBOX")).body.items.map(row => row.id), [id]);
    assert.equal((await t.messages("INBOX", "?folder=all")).status, 400);
    assert.equal(t.opens.length, opens, "platform organization and server cache GET must not connect to IMAP");
  } finally { await t.close(); }
});

test("INBOX catalog entry aliases existing receipts and data; request keys cannot cross folder or legacy entry points", async () => {
  const t = await normalFolderInboxFixture();
  try {
    const key = crypto.randomUUID(), received = await t.receive("INBOX", key);
    assert.equal(received.body.request.state, "committed", received.text);
    const old = (await t.request(`${t.base}/messages`)).body, current = (await t.messages("INBOX")).body;
    assert.equal(current.items[0].id, old.items[0].id); assert.equal(current.epochId, old.epochId);
    const opens = t.opens.length;
    assert.equal((await t.receive("Sent", key)).status, 409);
    assert.equal((await t.receive("INBOX", key)).body.request.state, "committed");
    assert.equal(t.opens.length, opens);
    const sentKey = crypto.randomUUID(); await t.receive("Sent", sentKey);
    const after = t.opens.length;
    assert.equal((await t.receive("INBOX", sentKey)).status, 409);
    assert.equal((await t.request(`${t.base}/sync`, { method: "POST", headers: { "idempotency-key": sentKey }, body: { expectedRevision: 1 } })).status, 409);
    assert.equal(t.opens.length, after);
    await t.h.db.prepare("UPDATE normal_server_folder_catalogs SET folders='[]' WHERE account_id=?").bind(t.id).run();
    assert.equal((await t.request(`${t.folderPath("INBOX")}/sync-requests/${key}`)).body.request.state, "committed");
    assert.equal((await t.request(`${t.folderPath("Sent")}/sync-requests/${sentKey}`)).body.request.state, "committed");
    assert.equal((await t.request(`${t.base}/server-folders/discover`, { method: "POST", body: { expectedRevision: 1 } })).status, 200);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) FROM normal_server_folder_state").first("COUNT(*)"), 1);
    const sent = (await t.messages("Sent")).body.items[0];
    for (const suffix of ["reply", "labels", "folder", "raw"]) assert.equal((await t.request(`${t.base}/messages/${sent.id}/${suffix}`)).status, 404);
    assert.equal((await t.request(`${t.base}/messages/${sent.id}/remote-flags`, { method: "POST", headers: { "idempotency-key": crypto.randomUUID() },
      body: { expectedRevision: 1, epochId: old.epochId, flag: "\\Seen", value: true } })).status, 404);
  } finally { await t.close(); }
});

test("same-folder lease conflicts without reconnecting while other folders may commit independently", async () => {
  const t = await normalFolderInboxFixture(), gate = t.holdPut(); let pending;
  try {
    const key = crypto.randomUUID(); pending = t.receive("Sent", key); await gate.entered;
    assert.equal((await t.messages("Sent")).body.items.length, 0);
    const opens = t.opens.length;
    assert.equal((await t.receive("Sent", key)).body.request.state, "pending");
    const conflict = await t.receive("Sent"); assert.equal(conflict.body.request.state, "failed", conflict.text);
    assert.equal(t.opens.length, opens);
    assert.equal((await t.receive("&Ti1lhw-")).body.request.state, "committed");
    gate.release(); assert.equal((await pending).body.request.state, "committed"); pending = null;
    assert.equal((await t.messages("Sent")).body.items.length, 1);
  } finally { gate.release(); if (pending) await pending; await t.close(); }
});

for (const change of ["account-revision", "owner-disabled", "directory-removed", "caller-revoked", "lease-successor"]) {
  test(`folder commit rechecks ${change} and old cleanup cannot release a successor`, async () => {
    const t = await normalFolderInboxFixture(), gate = t.holdPut(); let pending;
    try {
      const key = await newKey(t.h, t.alice.cookie, { scopes: ["mail-accounts:read", "messages:read", "mail-accounts:sync"] });
      pending = t.receive("Sent", crypto.randomUUID(), { cookie: undefined, token: key.token }); await gate.entered;
      if (change === "account-revision") assert.equal((await t.save({ displayName: "Updated" }, 1)).status, 200);
      if (change === "owner-disabled") await t.h.db.prepare("UPDATE users SET status='disabled' WHERE id=?").bind(t.alice.id).run();
      if (change === "directory-removed") await t.h.db.prepare("UPDATE normal_server_folder_catalogs SET folders='[]' WHERE account_id=?").bind(t.id).run();
      if (change === "caller-revoked") await t.h.db.prepare("UPDATE api_keys SET revoked_at=unixepoch() WHERE user_id=?").bind(t.alice.id).run();
      if (change === "lease-successor") await t.h.db.prepare("UPDATE normal_server_folder_state SET claim_token='successor' WHERE account_id=?").bind(t.id).run();
      gate.release(); await pending; pending = null;
      assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_messages").first("n"), 0);
      const state = await t.h.db.prepare("SELECT * FROM normal_server_folder_state").first();
      assert.equal(state.after_uid, 0); assert.equal(state.version, 0);
      if (change === "lease-successor") assert.equal(state.claim_token, "successor");
      assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_batches WHERE status='committed'").first("n"), 0);
    } finally { gate.release(); if (pending) await pending; await t.close(); }
  });
}

test("a cached detail is withheld when the directory changes during R2 read", async () => {
  const t = await normalFolderInboxFixture(); let pending, gate;
  try {
    await t.receive("Sent"); const item = (await t.messages("Sent")).body.items[0];
    gate = t.holdPut("/get"); pending = t.request(`${t.folderPath("Sent")}/messages/${item.id}`); await gate.entered;
    await t.h.db.prepare("UPDATE normal_server_folder_catalogs SET folders='[]' WHERE account_id=?").bind(t.id).run();
    gate.release(); const result = await pending; pending = null; assert.equal(result.status, 404, result.text);
    assert.equal(JSON.stringify(result.body).includes("Sent mail body"), false);
  } finally { gate?.release(); if (pending) await pending; await t.close(); }
});
