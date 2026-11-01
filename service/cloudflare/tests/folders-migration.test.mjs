import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { newKey } from "./runtime-harness.mjs";
import { foldersFixture, folderBody, putFolder, organize, expect } from "./folders-fixture.mjs";

test("0016 preserves existing rows, scopes, cursor fingerprints and W2 organization hashes/receipts", async () => {
  const f = await foldersFixture({}, false, "0015_labels_organization.sql"); const { h, alice, ids } = f;
  try {
    const old = await newKey(h, alice.cookie, { scopes: ["messages:read", "messages:write", "labels:read"] });
    const input = { messageIds: [...ids].sort(), isRead: true, starred: null, archived: null, trashed: null, addLabelIds: [], removeLabelIds: [] };
    const key = crypto.randomUUID(), operation = crypto.randomUUID(), hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    await h.db.prepare(`INSERT INTO organization_operations(user_id,request_key,id,request_hash,required_scopes,message_count,created_at,completed_at)
      VALUES(?,?,?,?,'["messages:write"]',2,1000,1000)`).bind(alice.id, key, operation, hash).run();
    await h.db.prepare("UPDATE messages SET is_read=1 WHERE user_id=?").bind(alice.id).run();
    const tables = ["users", "api_keys", "mailboxes", "messages", "labels", "message_labels", "organization_operations"];
    const before = await Promise.all(tables.map(async table => (await h.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results));
    const filters = { q: "", sender: "", recipient: "", mailboxId: "", providerId: "", folder: "inbox", isRead: null, starred: null, since: null, until: null };
    const fingerprint = createHash("sha256").update(JSON.stringify([alice.id, filters])).digest("hex");
    const first = await h.db.prepare("SELECT id,COALESCE(received_at,observed_at) time FROM messages WHERE user_id=? ORDER BY time DESC,id DESC LIMIT 1").bind(alice.id).first();
    const cursor = Buffer.from(JSON.stringify({ time: first.time, id: first.id, filter: fingerprint })).toString("base64url");
    await h.migrate(); await h.migrate();
    for (let i = 0; i < tables.length; i++) {
      const current = (await h.db.prepare(`SELECT * FROM ${tables[i]} ORDER BY rowid`).all()).results;
      const rows = tables[i] === "messages" ? current.map(({ thread_key, thread_basis, thread_version, thread_limited, ...legacy }) => {
        assert.deepEqual([thread_key, thread_basis, thread_version, thread_limited], [null, null, 0, 0]);
        return legacy;
      }) : current;
      assert.deepEqual(rows, before[i], tables[i]);
    }
    assert.equal(expect(await h.request(`/api/v1/messages?cursor=${cursor}`, { token: old.token })).items.length, 1);
    expect(await organize(h, alice, { messageIds: ids, isRead: false }));
    const replay = expect(await organize(h, alice, { messageIds: [...ids].reverse(), isRead: true }, key, { token: old.token }));
    assert.equal(replay.operation.id, operation); assert.equal(replay.replayed, true);
    assert.equal(await h.db.prepare("SELECT is_read FROM messages WHERE id=?").bind(ids[0]).first("is_read"), 0);
    const folder = crypto.randomUUID(); expect(await putFolder(h, alice, folder, folderBody()), 201);
    expect(await organize(h, alice, { messageIds: ids, folderId: folder })); await h.restart();
    assert.equal(expect(await h.request(`/api/v1/messages?folderId=${folder}`, { cookie: alice.cookie })).items.length, 2);
  } finally { await f.close(); }
});
