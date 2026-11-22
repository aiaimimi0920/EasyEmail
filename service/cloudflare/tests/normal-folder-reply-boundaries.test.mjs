import assert from "node:assert/strict";
import { test } from "node:test";
import { folderReplyFixture } from "./normal-folder-reply-fixture.mjs";
import { mailInput } from "./normal-send-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";
import { replyRaw } from "./normal-reply-fixture.mjs";

test("folder reply denies cross-account/folder, missing read scope, malformed filter and invalid remote flag writes", async () => {
  const t = await folderReplyFixture();
  try {
    await t.configure(); const source = await t.seedFolder(), other = await t.seedFolder("Sent"), bob = await t.h.register("folder-reply-bob");
    assert.equal((await t.h.request(`${source.path}/reply`, { cookie: bob.cookie })).status, 404);
    assert.equal((await t.h.request(`${t.path}/server-folders/${other.folderId}/messages/${source.id}/reply`, { cookie: t.alice.cookie })).status, 404);
    assert.equal((await t.h.request(`${source.path}/reply?unsafe=1`, { cookie: t.alice.cookie })).status, 400);
    assert.equal((await t.h.request(`${source.path}/reply`, { cookie: t.alice.cookie, method: "POST", body: {} })).status, 405);
    const invalidFlags = await t.h.request(`${source.path}/remote-flags`, { cookie: t.alice.cookie, method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() }, body: {} });
    assert.equal(invalidFlags.status, 400); assert.equal(invalidFlags.body.error.code, "invalid_remote_flags_request");
    for (const scopes of [["messages:read"], ["mail-accounts:read"], ["mail-accounts:send"], ["mail-accounts:schedule", "mail-accounts:send"]]) {
      const key = await newKey(t.h, t.alice.cookie, { scopes });
      assert.equal((await t.h.request(`${source.path}/reply`, { token: key.token })).status, 403);
      assert.equal((await t.send({ ...mailInput, replyToMessageId: source.id }, crypto.randomUUID(), { cookie: null, token: key.token })).status, 403);
    }
    assert.equal(t.opens.length, 0);
  } finally { await t.close(); }
});

test("folder reply refuses unpublished, trash, purged, stale catalog and invalid raw data without falling back to INBOX", async () => {
  const t = await folderReplyFixture();
  try {
    await t.configure(); const source = await t.seedFolder(), inbox = await t.seed(), path = `${source.path}/reply`;
    const preview = () => t.h.request(path, { cookie: t.alice.cookie });
    for (const [mutation, restore, status] of [
      ["UPDATE normal_server_folder_state SET after_uid=0", "UPDATE normal_server_folder_state SET after_uid=1", 400],
      ["UPDATE normal_inbox_messages SET purged_at=1 WHERE server_folder_id IS NOT NULL", "UPDATE normal_inbox_messages SET purged_at=NULL", 404],
      ["UPDATE normal_inbox_batches SET status='staged',committed_at=NULL WHERE server_folder_id IS NOT NULL", "UPDATE normal_inbox_batches SET status='committed',committed_at=1", 404],
      ["UPDATE normal_server_folder_catalogs SET source_hash='stale'", `UPDATE normal_server_folder_catalogs SET source_hash='${source.catalogSource}'`, 404],
      ["UPDATE normal_server_folder_state SET wire_name='wrong-folder'", "UPDATE normal_server_folder_state SET wire_name='Archive'", 404],
    ]) {
      await t.h.db.exec(mutation); assert.equal((await preview()).status, status, mutation);
      assert.ok((await t.send({ ...mailInput, replyToMessageId: source.id })).status >= 400, mutation); await t.h.db.exec(restore);
    }
    await t.h.db.prepare("INSERT INTO normal_message_state(message_id,trashed_at) VALUES (?,1)").bind(source.id).run();
    assert.equal((await preview()).body.error.code, "invalid_reply_source");
    await t.h.db.prepare("UPDATE normal_message_state SET trashed_at=NULL WHERE message_id=?").bind(source.id).run();
    await (await t.h.bucket("INBOX")).put(source.rawKey, "tampered");
    assert.equal((await preview()).body.error.code, "normal_content_unavailable");
    assert.equal((await t.h.request(`${inbox.path}/reply`, { cookie: t.alice.cookie })).status, 200); assert.equal(t.opens.length, 0);
  } finally { await t.close(); }
});

test("folder reply uses verified Reply-To or From and rejects ambiguous targets and caller-supplied thread fields", async () => {
  const t = await folderReplyFixture();
  try {
    await t.configure();
    const invalid = await t.seedFolder("Archive", replyRaw("Reply-To: a@example.test, b@example.test"));
    assert.equal((await t.h.request(`${invalid.path}/reply`, { cookie: t.alice.cookie })).body.error.code, "invalid_reply_source");
    const source = await t.seedFolder("Archive", replyRaw(""));
    const result = await t.h.request(`${source.path}/reply`, { cookie: t.alice.cookie });
    assert.equal(result.body.reply.to, "sender@example.test"); assert.equal(result.body.reply.threading, "unavailable");
    for (const extra of [{ inReplyTo: "<spoof@example.test>" }, { references: [] }, { serverFolderId: source.folderId }, { claim: {} }]) {
      assert.equal((await t.send({ ...mailInput, replyToMessageId: source.id, ...extra })).status, 400);
    }
    const sent = await t.send({ ...mailInput, replyToMessageId: source.id }); assert.equal(sent.status, 201, sent.text);
    assert.doesNotMatch(t.messages[0], /\r\n(?:In-Reply-To|References):/);
  } finally { await t.close(); }
});
