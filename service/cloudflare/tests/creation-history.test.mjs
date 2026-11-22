import assert from "node:assert/strict";
import { test } from "node:test";
import { adminFixture, ok } from "./admin-fixture.mjs";
import { automatic, creationCalls } from "./allocation-fixture.mjs";
import { allocate } from "./provider-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";

const root = "/api/v1/mailbox-creations";
const acknowledge = (h, cookie, row, extra = {}) => h.request(`${root}/${row.id}/acknowledge`, {
  cookie, method: "POST", body: { confirmAddress: row.address, acknowledgeUncertain: true }, ...extra,
});

test("creation history is owner-scoped, newest-first and paginated without exposing hashes, credentials or endpoint configuration", async () => {
  const a = await adminFixture(), { h, alice, admin, f } = a;
  try {
    const first = ok(await allocate(h, alice.cookie), 201).mailbox;
    const second = ok(await automatic(h, alice.cookie), 201).mailbox;
    await h.db.prepare("UPDATE mailbox_creations SET created_at=100 WHERE mailbox_id=?").bind(first.id).run();
    await h.db.prepare("UPDATE mailbox_creations SET created_at=200 WHERE mailbox_id=?").bind(second.id).run();
    const before = f.calls.length;
    const page = ok(await h.request(`${root}?limit=1`, { cookie: alice.cookie }));
    assert.equal(page.items[0].id, second.id); assert.equal(page.nextCursor, second.id);
    const next = ok(await h.request(`${root}?limit=1&cursor=${page.nextCursor}`, { cookie: alice.cookie }));
    assert.equal(next.items[0].id, first.id); assert.equal(next.nextCursor, null);
    assert.equal(page.items[0].state, "complete"); assert.equal(page.items[0].acknowledgedAt, null);
    assert.match(page.items[0].requestKey, /^[0-9a-f-]{36}$/);
    for (const secret of ["request_hash", "provider_hash", "config_hash", "credential_cipher", "synthetic-cf-admin", "baseUrl", alice.id]) {
      assert.equal(JSON.stringify(page).includes(secret), false, secret);
    }
    assert.deepEqual(ok(await h.request(root, { cookie: admin.cookie })).items, []);
    assert.equal((await h.request(`${root}/${first.id}`, { cookie: admin.cookie })).status, 404);
    assert.equal((await h.request(`${root}?cursor=${first.id}`, { cookie: admin.cookie })).status, 400);
    assert.equal((await h.request(`${root}?state=invalid`, { cookie: alice.cookie })).status, 400);
    assert.equal((await h.request(`${root}?unexpected=1`, { cookie: alice.cookie })).status, 400);
    assert.equal(f.calls.length, before);
  } finally { await a.close(); }
});

test("acknowledging an unknown creation preserves its guard and quota, is idempotent across restart, and never retries the upstream write", async () => {
  const a = await adminFixture(), { h, alice, f } = a;
  try {
    f.modes.set("/cf/admin/new_address", "invalid");
    const key = crypto.randomUUID(), unknown = ok(await automatic(h, alice.cookie, key), 202).creation;
    const row = ok(await h.request(`${root}/${unknown.mailboxId}`, { cookie: alice.cookie })).creation;
    assert.equal(row.state, "unknown"); assert.equal(row.requestKey, key); assert.equal(row.retrySafe, false);
    const calls = f.calls.length, before = await h.db.prepare("SELECT * FROM mailbox_creations WHERE mailbox_id=?").bind(row.id).first();
    assert.equal((await acknowledge(h, alice.cookie, row, { body: { confirmAddress: row.address } })).status, 400);
    assert.equal((await acknowledge(h, alice.cookie, row, { body: { confirmAddress: "other@example.test", acknowledgeUncertain: true } })).status, 400);
    const acknowledged = ok(await acknowledge(h, alice.cookie, row)).creation;
    assert.ok(acknowledged.acknowledgedAt); assert.equal(acknowledged.state, "unknown"); assert.equal(acknowledged.retrySafe, false);
    await h.restart();
    assert.deepEqual(ok(await acknowledge(h, alice.cookie, row)).creation, acknowledged);
    const after = await h.db.prepare("SELECT * FROM mailbox_creations WHERE mailbox_id=?").bind(row.id).first();
    for (const [name, value] of Object.entries(before)) if (name !== "acknowledged_at") assert.deepEqual(after[name], value, name);
    assert.equal(ok(await automatic(h, alice.cookie, key), 202).creation.state, "unknown");
    assert.equal(f.calls.length, calls); assert.equal(creationCalls(f).length, 1);
    assert.deepEqual(ok(await h.request(`${root}?state=unresolved`, { cookie: alice.cookie })).items, []);
    assert.equal(ok(await h.request(root, { cookie: alice.cookie })).items[0].id, row.id);
    ok(await automatic(h, alice.cookie), 201);
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM mailbox_creations").first()).n, 2);
    assert.equal(creationCalls(f).length, 1);
  } finally { await a.close(); }
});

test("history reads and acknowledgements enforce independent read/write scopes, cookie Origin and user ownership", async () => {
  const a = await adminFixture(), { h, alice, admin, f } = a;
  try {
    f.modes.set("/cf/admin/new_address", "invalid");
    const unknown = ok(await automatic(h, alice.cookie), 202).creation;
    const row = ok(await h.request(`${root}/${unknown.mailboxId}`, { cookie: alice.cookie })).creation;
    const reader = await newKey(h, alice.cookie), writer = await newKey(h, alice.cookie, { scopes: ["mailboxes:write"] });
    assert.equal((await h.request(root, { token: writer.token })).status, 403);
    assert.equal((await h.request(`${root}/${row.id}`, { token: writer.token })).status, 403);
    ok(await h.request(root, { token: reader.token }));
    assert.equal((await acknowledge(h, null, row, { token: reader.token })).status, 403);
    assert.equal((await acknowledge(h, alice.cookie, row, { origin: null })).status, 403);
    assert.equal((await acknowledge(h, admin.cookie, row)).status, 404);
    ok(await acknowledge(h, null, row, { token: writer.token, origin: null }));
    await h.db.prepare("UPDATE mailbox_creations SET error_code='synthetic-private-secret'").run();
    assert.equal(ok(await h.request(`${root}/${row.id}`, { token: reader.token })).creation.error, "creation_unconfirmed");
    assert.equal((await h.request(root)).status, 401);
  } finally { await a.close(); }
});
