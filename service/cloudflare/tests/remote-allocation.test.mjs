import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { remoteAllocationFixture, remoteAllocate } from "./remote-allocation-fixture.mjs";

let f, h, alice, bob;
before(async () => { f = await remoteAllocationFixture(); h = f.h; alice = await h.register("remote-alice"); bob = await h.register("remote-bob"); });
beforeEach(async () => {
  await h.resetLimits(); f.modes.clear(); f.patches.clear();
  // Each case owns its failure observation; do not let a preceding lost ACK cool later cases.
  await h.db.prepare("UPDATE provider_allocation_state SET cooldown_until=NULL,failure_count=0,last_error=NULL").run();
});
after(async () => { await f?.close(); });

test("remote allocation persists the actual server address and expiry, sends only the chosen domain, and replays without another remote write", async () => {
  const key = crypto.randomUUID(), result = await remoteAllocate(h, alice.cookie, key); assert.equal(result.status, 201, result.text);
  const box = result.body.mailbox, actual = f.allocations.at(-1), row = await h.db.prepare("SELECT * FROM mailbox_creations WHERE mailbox_id=?").bind(box.id).first();
  assert.equal(box.address, actual.address); assert.equal(box.expiresAt, actual.expiresAt); assert.equal(row.address, actual.address); assert.equal(row.state, "complete");
  assert.deepEqual(f.calls.at(-1).body, { domain: "remote.example.test" }); const count = f.calls.length; await h.restart();
  assert.equal((await remoteAllocate(h, alice.cookie, key)).body.mailbox.id, box.id); assert.equal(f.calls.length, count);
});

test("an in-flight request publishes no invented address, reconciles the same key, and acknowledges uncertainty by request key before a late success", async () => {
  const key = crypto.randomUUID(), gate = f.hold(), pending = remoteAllocate(h, alice.cookie, key); let row;
  try {
    await gate.entered; row = await h.db.prepare("SELECT * FROM mailbox_creations WHERE request_key=?").bind(key).first();
    const detail = (await h.request(`/api/v1/mailbox-creations/${row.mailbox_id}`, { cookie: alice.cookie })).body.creation;
    assert.equal(detail.address, null); assert.equal(detail.addressPending, true); assert.equal(detail.requestedDomain, "remote.example.test");
    assert.equal(JSON.stringify(detail).includes("remote-random:"), false);
    const replay = await remoteAllocate(h, alice.cookie, key); assert.equal(replay.status, 202); assert.equal(replay.body.creation.address, null);
    assert.equal((await h.request(`/api/v1/mailbox-creations/${row.mailbox_id}`, { cookie: bob.cookie })).status, 404);
    const ack = body => h.request(`/api/v1/mailbox-creations/${row.mailbox_id}/acknowledge`, { method: "POST", cookie: alice.cookie, body });
    for (const body of [{ confirmAddress: null, acknowledgeUncertain: true }, { confirmAddress: row.address, acknowledgeUncertain: true },
      { confirmRequestKey: "wrong", acknowledgeUncertain: true }, { confirmRequestKey: key, acknowledgeUncertain: false }]) assert.equal((await ack(body)).status, 400);
    assert.equal((await ack({ confirmRequestKey: key, acknowledgeUncertain: true })).status, 200);
  } finally { gate.release(); }
  const result = await pending; assert.equal(result.status, 201, result.text); assert.equal(result.body.mailbox.id, row.mailbox_id);
  const history = (await h.request(`/api/v1/mailbox-creations/${row.mailbox_id}`, { cookie: alice.cookie })).body.creation;
  assert.equal(history.address, result.body.mailbox.address); assert.ok(history.acknowledgedAt); assert.equal(history.addressPending, undefined);
});

test("a lost upstream ACK keeps an unknown address across restart and acknowledgement never retries the original allocation", async () => {
  f.modes.add("lost-ack"); const key = crypto.randomUUID(), count = f.calls.length, result = await remoteAllocate(h, alice.cookie, key);
  assert.equal(result.status, 202, result.text); assert.equal(result.body.creation.state, "unknown"); assert.equal(result.body.creation.address, null);
  assert.equal(result.body.creation.retrySafe, false); await h.restart();
  assert.equal((await remoteAllocate(h, alice.cookie, key)).body.creation.address, null); assert.equal(f.calls.length, count + 1);
  const id = result.body.creation.mailboxId, ack = await h.request(`/api/v1/mailbox-creations/${id}/acknowledge`, { method: "POST", cookie: alice.cookie,
    body: { confirmRequestKey: key, acknowledgeUncertain: true } });
  assert.equal(ack.status, 200, ack.text); assert.equal(ack.body.creation.state, "unknown"); assert.equal(ack.body.creation.address, null); assert.equal(f.calls.length, count + 1);
  const cooling = await remoteAllocate(h, alice.cookie); assert.equal(cooling.status, 409); assert.equal(cooling.body.error.code, "provider_cooling");
  assert.equal(f.calls.length, count + 1);
});

test("invalid or wrong-domain remote addresses never become local mailbox identities and never trigger fallback writes", async () => {
  for (const address of ["foreign@other.example.test", "bad address", "", undefined, 123]) {
    await h.resetLimits(); f.patches.set("address", address); const key = crypto.randomUUID(), count = f.calls.length, result = await remoteAllocate(h, alice.cookie, key);
    assert.equal(result.status, 202, result.text); assert.equal(result.body.creation.address, null); assert.equal(result.body.creation.state, "unknown");
    assert.equal(await h.db.prepare("SELECT * FROM mailboxes WHERE id=?").bind(result.body.creation.mailboxId).first(), null);
    assert.equal((await remoteAllocate(h, alice.cookie, key)).body.creation.state, "unknown"); assert.equal(f.calls.length, count + 1);
  }
});

test("a validated address is durably reserved before mailbox storage and stays known on storage failure without dispatching twice", async () => {
  await h.db.prepare("CREATE TRIGGER remote_mailbox_fail BEFORE INSERT ON mailboxes BEGIN SELECT RAISE(ABORT,'synthetic'); END").run();
  const key = crypto.randomUUID(); let result;
  try { result = await remoteAllocate(h, alice.cookie, key); assert.equal(result.body.creation.state, "unknown"); assert.equal(result.body.creation.address, f.allocations.at(-1).address); }
  finally { await h.db.prepare("DROP TRIGGER remote_mailbox_fail").run(); }
  const row = await h.db.prepare("SELECT * FROM mailbox_creations WHERE mailbox_id=?").bind(result.body.creation.mailboxId).first(); assert.equal(row.address, result.body.creation.address);
  const count = f.calls.length; assert.equal((await remoteAllocate(h, alice.cookie, key)).body.creation.address, row.address); assert.equal(f.calls.length, count);
  assert.equal(await h.db.prepare("SELECT * FROM mailboxes WHERE id=?").bind(row.mailbox_id).first(), null);
  const ack = await h.request(`/api/v1/mailbox-creations/${row.mailbox_id}/acknowledge`, { method: "POST", cookie: alice.cookie,
    body: { confirmRequestKey: key, acknowledgeUncertain: true } }); assert.equal(ack.status, 400, "A known address still requires exact address confirmation");
});

test("parallel remote allocations returning the same address have one local owner and the loser cannot claim or expose the other mailbox", async () => {
  f.patches.set("address", "shared@remote.example.test"); const count = f.calls.length;
  const results = await Promise.all([remoteAllocate(h, alice.cookie), remoteAllocate(h, bob.cookie)]);
  assert.deepEqual(results.map(row => row.status).sort(), [201, 202]); assert.equal(f.calls.length, count + 2);
  const winner = results.find(row => row.status === 201).body.mailbox, loser = results.find(row => row.status === 202).body.creation;
  assert.equal(loser.address, null); assert.equal(loser.error, "mailbox_address_unavailable");
  assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM mailboxes WHERE address='shared@remote.example.test'").first()).n, 1);
  const loserCookie = results[0].status === 202 ? alice.cookie : bob.cookie;
  assert.equal((await h.request(`/api/v1/mailboxes/${winner.id}`, { cookie: loserCookie })).status, 404);
});

test("a mailbox imported without a creation guard still blocks address takeover and failed binding never publishes the private reservation marker", async () => {
  const id = crypto.randomUUID(); await h.db.prepare("INSERT INTO mailboxes(id,user_id,provider_id,remote_id,address,status,created_at) VALUES(?,?,'remote-fixture','existing','imported@remote.example.test','active',1)").bind(id, bob.id).run();
  f.patches.set("address", "imported@remote.example.test"); let result = await remoteAllocate(h, alice.cookie);
  assert.equal(result.body.creation.address, null); assert.equal(result.body.creation.error, "mailbox_address_unavailable");
  f.patches.clear(); await h.db.prepare("CREATE TRIGGER remote_bind_fail BEFORE UPDATE OF address ON mailbox_creations BEGIN SELECT RAISE(ABORT,'synthetic'); END").run();
  try { result = await remoteAllocate(h, alice.cookie); assert.equal(result.body.creation.address, null); assert.equal(result.body.creation.error, "creation_storage_failed"); }
  finally { await h.db.prepare("DROP TRIGGER remote_bind_fail").run(); }
  const history = await h.request("/api/v1/mailbox-creations", { cookie: alice.cookie }); assert.equal(history.text.includes("remote-random:"), false);
});

test("a committed address binding whose local ACK is lost is reconciled from storage and never dispatches the original allocation again", async () => {
  const key = crypto.randomUUID(), count = f.calls.length, result = await remoteAllocate(h, alice.cookie, key,
    { headers: { "idempotency-key": key, "x-test-remote-allocation-fault": "bind-ack-lost" } });
  assert.equal(result.status, 202, result.text); assert.equal(result.body.creation.state, "unknown");
  assert.equal(result.body.creation.address, f.allocations.at(-1).address); assert.equal(result.body.creation.addressPending, undefined);
  await h.restart(); assert.equal((await remoteAllocate(h, alice.cookie, key)).body.creation.address, result.body.creation.address);
  assert.equal(f.calls.length, count + 1);
});

test("acknowledgement compares the original address reservation and requires a refresh if binding wins the race", async () => {
  f.modes.add("lost-ack"); const key = crypto.randomUUID(), result = await remoteAllocate(h, alice.cookie, key);
  assert.equal(result.status, 202, result.text); const id = result.body.creation.mailboxId, count = f.calls.length;
  const ack = await h.request(`/api/v1/mailbox-creations/${id}/acknowledge`, { method: "POST", cookie: alice.cookie,
    headers: { "x-test-remote-allocation-fault": "ack-address-race" }, body: { confirmRequestKey: key, acknowledgeUncertain: true } });
  assert.equal(ack.status, 409, ack.text); assert.equal(ack.body.error.code, "creation_state_changed");
  const row = (await h.request(`/api/v1/mailbox-creations/${id}`, { cookie: alice.cookie })).body.creation;
  assert.equal(row.address, "confirmed@remote.example.test"); assert.equal(row.acknowledgedAt, null);
  assert.equal((await h.request(`/api/v1/mailbox-creations/${id}/acknowledge`, { method: "POST", cookie: alice.cookie,
    body: { confirmRequestKey: key, acknowledgeUncertain: true } })).status, 400);
  assert.equal((await h.request(`/api/v1/mailbox-creations/${id}/acknowledge`, { method: "POST", cookie: alice.cookie,
    body: { confirmAddress: row.address, acknowledgeUncertain: true } })).status, 200);
  assert.equal(f.calls.length, count);
});
