import assert from "node:assert/strict";
import { test } from "node:test";
import { mutationOperationFixture } from "./normal-mutation-operation-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";

test("move and permanent delete require independent scopes, real owner and session Origin", async () => {
  const t = await mutationOperationFixture(), key = crypto.randomUUID();
  try {
    const opens = t.opens.length;
    for (const scopes of [["mail-accounts:read", "messages:read"], ["mail-accounts:read", "mail-accounts:remote-move"],
      ["messages:read", "mail-accounts:remote-move"], ["mail-accounts:read", "messages:read", "mail-accounts:remote-flags"]]) {
      const api = await newKey(t.h, t.alice.cookie, { scopes });
      assert.equal((await t.mutate(crypto.randomUUID(), {}, { cookie: undefined, token: api.token })).status, 403);
    }
    assert.equal((await t.mutate(key, {}, { origin: null })).status, 403);
    const bob = await t.h.register(`mutation-${crypto.randomUUID().slice(0, 8)}`);
    assert.equal((await t.mutate(key, {}, { cookie: bob.cookie })).status, 404);
    const move = await newKey(t.h, t.alice.cookie, { scopes: ["mail-accounts:read", "messages:read", "mail-accounts:remote-move"] });
    const remove = await newKey(t.h, t.alice.cookie, { scopes: ["mail-accounts:read", "messages:read", "mail-accounts:remote-delete"] });
    assert.equal((await t.remove(key, { cookie: undefined, token: move.token })).status, 403);
    assert.equal((await t.mutate(key, {}, { cookie: undefined, token: remove.token })).status, 403);
    assert.equal(t.opens.length, opens);
    assert.equal((await t.mutate(key, {}, { cookie: undefined, token: move.token })).body.operation.state, "confirmed");
    assert.equal((await t.operation(key, { cookie: undefined, token: remove.token })).status, 403);
    assert.equal((await t.latest({ cookie: undefined, token: remove.token })).status, 403);
    assert.equal((await t.operation(key, { cookie: bob.cookie })).status, 404);
    assert.equal((await t.operation(key, { cookie: undefined, token: move.token })).body.operation.state, "confirmed");
  } finally { await t.close(); }
});
test("strict body validation and source/destination identities reject mixed or unconfirmed mutations before sockets", async () => {
  const t = await mutationOperationFixture();
  try {
    assert.equal((await t.receive("INBOX")).body.request.state, "committed");
    const inboxEpoch = (await t.messages("INBOX")).body.epochId;
    const opens = t.opens.length;
    for (const fields of [{ action: "archive" }, { confirmRemoteChange: false }, { confirmPermanentDelete: true },
      { destinationFolderId: "not-a-folder" }, { epochId: "invalid" }, { expectedRevision: 0 }, { acknowledgedUnknownId: "old" },
      { destinationEpochId: "invalid" }, { destinationFolderId: t.folder(t.source).id, destinationEpochId: t.item.epochId }]) {
      assert.equal((await t.mutate(crypto.randomUUID(), fields)).status, 400, JSON.stringify(fields));
    }
    const wrongEpoch = await t.mutate(crypto.randomUUID(), { destinationEpochId: crypto.randomUUID() });
    assert.equal(wrongEpoch.status, 409, wrongEpoch.text);
    for (const [root, epochId] of [[t.base, inboxEpoch], [t.folderPath(t.destination), t.body.destinationEpochId], [t.folderPath("INBOX"), inboxEpoch]]) {
      assert.equal((await t.request(`${root}/messages/${t.item.id}/remote-mutations`, { method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() }, body: { ...t.body, epochId } })).status, 404);
    }
    assert.equal(t.opens.length, opens); const key = crypto.randomUUID(), result = await t.mutate(key);
    assert.equal(result.body.operation.state, "confirmed");
    for (const root of [t.base, t.folderPath(t.destination), t.folderPath("INBOX")]) {
      assert.equal((await t.request(`${root}/remote-mutation-operations/${key}`)).status, 404);
    }
    assert.equal(t.opens.length, opens + 1);
  } finally { await t.close(); }
});
test("incomplete lock schema fails closed and never exposes a new protocol write", async () => {
  const t = await mutationOperationFixture();
  try {
    await t.h.db.prepare("DROP TRIGGER normal_remote_flags_exclude_mutation_dispatch").run();
    const opens = t.opens.length, result = await t.mutate();
    assert.equal(result.status, 409, result.text); assert.equal(result.body.error.code, "remote_mutation_schema_required"); assert.equal(t.opens.length, opens);
  } finally { await t.close(); }
});
