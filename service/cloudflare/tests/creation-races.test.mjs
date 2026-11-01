import assert from "node:assert/strict";
import { test } from "node:test";
import { adminFixture, ok } from "./admin-fixture.mjs";
import { automatic, creationCalls } from "./allocation-fixture.mjs";

const root = "/api/v1/mailbox-creations";
const acknowledge = (h, cookie, row) => h.request(`${root}/${row.id}/acknowledge`, {
  cookie, method: "POST", body: { confirmAddress: row.address, acknowledgeUncertain: true },
});

test("a pending acknowledgement does not cancel an in-flight creation; its late completion and original key remain authoritative", async () => {
  const a = await adminFixture(), { h, alice, f } = a;
  let gate;
  try {
    const key = crypto.randomUUID();
    gate = f.hold("/cf/admin/new_address"); const creating = automatic(h, alice.cookie, key);
    await gate.entered;
    const row = ok(await h.request(`${root}?state=unresolved`, { cookie: alice.cookie })).items[0];
    assert.equal(row.state, "pending");
    const [first, second] = await Promise.all([acknowledge(h, alice.cookie, row), acknowledge(h, alice.cookie, row)]);
    assert.equal(ok(first).creation.acknowledgedAt, ok(second).creation.acknowledgedAt);
    assert.equal((await h.db.prepare("SELECT state FROM mailbox_creations WHERE mailbox_id=?").bind(row.id).first()).state, "pending");
    gate.release(); const box = ok(await creating, 201).mailbox;
    assert.equal(box.id, row.id);
    const history = ok(await h.request(`${root}/${row.id}`, { cookie: alice.cookie })).creation;
    assert.equal(history.state, "complete"); assert.ok(history.acknowledgedAt);
    assert.equal((await acknowledge(h, alice.cookie, row)).body.error.code, "creation_state_changed");
    await h.restart();
    assert.equal(ok(await automatic(h, alice.cookie, key)).mailbox.id, row.id);
    assert.equal(creationCalls(f).length, 1);
  } finally { gate?.release(); await a.close(); }
});

test("a failed local acknowledgement is retryable without changing guard, allocation count, unknown state or upstream calls", async () => {
  const a = await adminFixture(), { h, alice, f } = a;
  try {
    f.modes.set("/cf/admin/new_address", "invalid"); ok(await automatic(h, alice.cookie), 202);
    const row = ok(await h.request(root, { cookie: alice.cookie })).items[0], calls = f.calls.length;
    const allocation = await h.db.prepare("SELECT * FROM provider_allocation_state").all();
    await h.db.prepare("CREATE TRIGGER fail_ack BEFORE UPDATE OF acknowledged_at ON mailbox_creations BEGIN SELECT RAISE(ABORT,'synthetic ack failure'); END").run();
    try { assert.equal((await acknowledge(h, alice.cookie, row)).status, 500); }
    finally { await h.db.prepare("DROP TRIGGER fail_ack").run(); }
    assert.equal(ok(await h.request(`${root}/${row.id}`, { cookie: alice.cookie })).creation.acknowledgedAt, null);
    ok(await acknowledge(h, alice.cookie, row));
    assert.deepEqual((await h.db.prepare("SELECT * FROM provider_allocation_state").all()).results, allocation.results);
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM mailbox_creations").first()).n, 1);
    assert.equal(f.calls.length, calls);
  } finally { await a.close(); }
});
