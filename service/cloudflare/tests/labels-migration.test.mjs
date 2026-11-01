import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { newKey } from "./runtime-harness.mjs";
import { labelsFixture, labelBody, putLabel, organize, expect } from "./labels-fixture.mjs";

test("0015 expansion preserves data and old scopes; a pre-upgrade unlabelled cursor stays valid", async () => {
  const f = await labelsFixture({}, false, "0014_cloud_drafts.sql");
  const { h, alice, ids } = f;
  try {
    const key = await newKey(h, alice.cookie, { scopes: ["messages:read", "messages:write"] });
    const before = (await h.db.prepare("SELECT * FROM messages ORDER BY id").all()).results;
    // Build the historical fingerprint directly from the 0003 query contract, not the current parser.
    const filters = { q: "", sender: "", recipient: "", mailboxId: "", providerId: "", folder: "inbox", isRead: null, starred: null, since: null, until: null };
    const historical = createHash("sha256").update(JSON.stringify([alice.id, filters])).digest("hex");
    // Execute the historical inbox ordering on the old schema. New runtime queries require all current migrations first.
    const old = await h.db.prepare(`SELECT id,COALESCE(received_at,observed_at) time FROM messages
      WHERE user_id=? AND purged_at IS NULL AND trashed_at IS NULL AND archived=0 ORDER BY COALESCE(received_at,observed_at) DESC,id DESC LIMIT 1`).bind(alice.id).first();
    const first = { items: [old], nextCursor: Buffer.from(JSON.stringify({ time: old.time, id: old.id, filter: historical })).toString("base64url") };
    const cursor = JSON.parse(Buffer.from(first.nextCursor, "base64url")); assert.equal(cursor.filter, historical);
    const scopes = await h.db.prepare("SELECT scopes FROM api_keys WHERE id=?").bind(key.id).first("scopes");
    await h.migrate(); await h.migrate();
    const current = (await h.db.prepare("SELECT * FROM messages ORDER BY id").all()).results;
    assert.deepEqual(current.map(({ thread_key, thread_basis, thread_version, thread_limited, ...legacy }) => {
      assert.deepEqual([thread_key, thread_basis, thread_version, thread_limited], [null, null, 0, 0]);
      return legacy;
    }), before);
    assert.equal(await h.db.prepare("SELECT scopes FROM api_keys WHERE id=?").bind(key.id).first("scopes"), scopes);
    const next = expect(await h.request(`/api/v1/messages?limit=1&cursor=${first.nextCursor}`, { token: key.token }));
    assert.equal(next.items.length, 1); assert.notEqual(next.items[0].id, first.items[0].id);
    const label = crypto.randomUUID(); expect(await putLabel(h, alice, label, labelBody()), 201);
    expect(await organize(h, alice, { messageIds: ids, addLabelIds: [label] }));
    await h.restart();
    assert.equal(expect(await h.request(`/api/v1/messages?labelId=${label}`, { cookie: alice.cookie })).items.length, 2);
  } finally { await f.close(); }
});
