import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { readFile } from "node:fs/promises";
import { remoteFixture } from "./remote-fixture.mjs";

let f;
before(async () => {
  f = await remoteFixture({ fullSchema: true });
}, { timeout: 90000 });
after(async () => { await f?.close(); }, { timeout: 15000 });
const tables = ["address", "raw_mails", "raw_mail_resources", "address_sender", "sendbox", "auto_reply_mails", "users_address", "address_delete_operations"];
async function box() {
  const response = await fetch(`${f.baseUrl}/admin/new_address`, { method: "POST",
    headers: { "x-admin-auth": "synthetic-cf-admin", "x-custom-auth": "synthetic-site-password", "content-type": "application/json" },
    body: JSON.stringify({ name: `synthetic-${crypto.randomUUID()}`, domain: "cf.example.test" }) });
  assert.equal(response.status, 200); const row = await response.json();
  return { address: row.address, token: row.jwt, addressId: String(row.address_id), requestId: crypto.randomUUID() };
}
const input = ({ address, addressId, requestId }) => ({ address, addressId, requestId });
async function snapshot() {
  const state = {};
  for (const table of tables) state[table] = (await f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
  return state;
}
async function seedRelated(b, id) {
  await f.seed(b.address, id);
  await f.db.batch([
    f.db.prepare("INSERT INTO address_sender(address,balance) VALUES(?,7)").bind(b.address),
    f.db.prepare("INSERT INTO sendbox(address,raw) VALUES(?,'synthetic sent data')").bind(b.address),
    f.db.prepare("INSERT INTO auto_reply_mails(address,message) VALUES(?,'synthetic auto reply')").bind(b.address),
    f.db.prepare("INSERT INTO users_address(address_id,user_id) VALUES(?,123)").bind(Number(b.addressId)),
  ]);
}

test("address capability requires current generation; existing string JWT IDs are strict canonical safe integers", async () => {
  const b = await box();
  for (const headers of [{}, { "x-fixture-address-id-format": "string" }]) {
    const result = await f.request("/address_deletion_capability", b.token, undefined, headers);
    assert.equal(result.status, 200); assert.equal(result.body.capability.addressId, b.addressId);
    assert.equal(result.body.capability.externalResourcesDeleted, false);
  }
  for (const value of ["0", "-1", "01", "1e0", " 1", "1junk", "9007199254740992"]) {
    assert.equal((await f.request("/address_deletion_capability", b.token, undefined,
      { "x-fixture-address-id-format": "string", "x-fixture-address-id-value": JSON.stringify(value) })).status, 403, JSON.stringify(value));
  }
});

test("address deletion atomically removes only matching D1 data and durable replay never deletes a replacement", async () => {
  const b = await box(), other = await box(); await seedRelated(b, 501); await seedRelated(other, 502);
  const result = await f.request("/address_deletions", b.token, input(b));
  assert.equal(result.status, 200); assert.equal(result.body.operation.state, "deleted");
  assert.equal(result.body.externalResourcesDeleted, false);
  for (const table of ["address_sender", "sendbox", "auto_reply_mails", "raw_mails"]) {
    assert.equal((await f.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE address=?`).bind(b.address).first()).n, 0);
    assert.equal((await f.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE address=?`).bind(other.address).first()).n, 1);
  }
  assert.equal(await f.db.prepare("SELECT mail_id FROM raw_mail_resources WHERE mail_id=501").first(), null);
  assert.equal(await f.db.prepare("SELECT id FROM users_address WHERE address_id=?").bind(Number(b.addressId)).first(), null);
  await f.db.prepare("INSERT INTO address(name) VALUES(?)").bind(b.address).run(); await f.seed(b.address, 501);
  await f.db.prepare("UPDATE fixture_settings SET enabled=0").run();
  try {
    assert.deepEqual((await f.request("/address_deletions", b.token, input(b))).body, result.body);
    assert.deepEqual((await f.request(`/address_deletions/${b.requestId}`, b.token)).body, result.body);
    assert.ok(await f.db.prepare("SELECT id FROM raw_mails WHERE id=501").first());
    assert.equal((await f.request(`/address_deletions/${b.requestId}`, other.token)).status, 404);
  } finally { await f.db.prepare("UPDATE fixture_settings SET enabled=1").run(); }
  await f.migrate(); assert.deepEqual((await f.request(`/address_deletions/${b.requestId}`, b.token)).body, result.body);
});

test("old generation cannot delete a transferred or recreated name; absence never claims this request deleted data", async () => {
  const b = await box(); await seedRelated(b, 503);
  await f.db.prepare("DELETE FROM address WHERE id=?").bind(Number(b.addressId)).run();
  await f.db.prepare("INSERT INTO address(name) VALUES(?)").bind(b.address).run();
  const before = await snapshot();
  const changed = await f.request("/address_deletions", b.token, input(b));
  assert.equal(changed.body.operation.state, "changed");
  assert.equal((await f.request("/address_deletion_capability", b.token)).status, 403);
  const after = await snapshot(); delete before.address_delete_operations; delete after.address_delete_operations;
  assert.deepEqual(after, before);
  const absent = await box(); await f.seed(absent.address, 504);
  await f.db.prepare("DELETE FROM address WHERE id=?").bind(Number(absent.addressId)).run();
  assert.equal((await f.request("/address_deletions", absent.token, input(absent))).body.operation.state, "absent");
  assert.ok(await f.db.prepare("SELECT id FROM raw_mails WHERE id=504").first());
});

test("a late SQL failure rolls back every related deletion and receipt; the same request can then complete", async () => {
  const b = await box(); await seedRelated(b, 505); const before = await snapshot();
  await f.db.prepare("CREATE TRIGGER fail_address_delete BEFORE DELETE ON address BEGIN SELECT RAISE(ABORT,'private SQL failure'); END").run();
  try {
    const failure = await f.request("/address_deletions", b.token, input(b));
    assert.equal(failure.status, 503); assert.equal(JSON.stringify(failure.body).includes("private SQL failure"), false);
    assert.deepEqual(await snapshot(), before);
  } finally { await f.db.prepare("DROP TRIGGER fail_address_delete").run(); }
  assert.equal((await f.request("/address_deletions", b.token, input(b))).body.operation.state, "deleted");
});

test("disable gates only new writes; malformed or oversized requests mutate nothing", async () => {
  const b = await box(), before = await snapshot();
  for (const body of [null, {}, { ...input(b), extra: true }, { ...input(b), requestId: "bad" }]) {
    assert.equal((await f.request("/address_deletions", b.token, body)).status, 400);
  }
  for (const body of [{ ...input(b), addressId: `0${b.addressId}` }, { ...input(b), address: "other@example.test" }]) {
    assert.equal((await f.request("/address_deletions", b.token, body)).status, 403);
  }
  assert.equal((await f.request("/address_deletions", b.token, { ...input(b), extra: "x".repeat(9000) })).status, 413);
  assert.equal((await f.request("/address_deletions", b.token, input(b), { "content-type": "text/plain" })).status, 415);
  await f.db.prepare("UPDATE fixture_settings SET enabled=0").run();
  try { assert.equal((await f.request("/address_deletions", b.token, input(b))).status, 403); }
  finally { await f.db.prepare("UPDATE fixture_settings SET enabled=1").run(); }
  assert.deepEqual(await snapshot(), before);
});

test("concurrent identical requests have one receipt and one cleanup, without touching replacement data on replay", async () => {
  const b = await box(); await f.seed(b.address, 506);
  await f.db.prepare("CREATE TABLE delete_counter(n INTEGER)").run(); await f.db.prepare("INSERT INTO delete_counter VALUES(0)").run();
  await f.db.prepare("CREATE TRIGGER count_address_delete AFTER DELETE ON address BEGIN UPDATE delete_counter SET n=n+1; END").run();
  try {
    const results = await Promise.all(Array.from({ length: 4 }, () => f.request("/address_deletions", b.token, input(b))));
    assert.ok(results.every((row) => row.status === 200 && row.body.operation.state === "deleted"));
    assert.equal((await f.db.prepare("SELECT n FROM delete_counter").first()).n, 1);
    await f.db.prepare("INSERT INTO address(id,name) VALUES(?,?)").bind(Number(b.addressId), b.address).run(); await f.seed(b.address, 506);
    assert.equal((await f.request("/address_deletions", b.token, input(b))).body.operation.state, "deleted");
    assert.ok(await f.db.prepare("SELECT id FROM raw_mails WHERE id=506").first());
  } finally { await f.db.prepare("DROP TRIGGER count_address_delete").run(); }
});

test("schema drift fails closed, migration matches fresh SQL, and receipts survive repeated migration", async () => {
  const b = await box();
  const schema = await readFile(new URL("../../../upstreams/cloudflare_temp_email/db/schema.sql", import.meta.url), "utf8");
  const patch = await readFile(new URL("../../../upstreams/cloudflare_temp_email/db/2026-10-28-address-deletions.sql", import.meta.url), "utf8");
  assert.ok(schema.trimEnd().endsWith(patch.trimEnd()));
  const source = await readFile(new URL("../../../upstreams/cloudflare_temp_email/worker/src/mails_api/address_deletion_schema.ts", import.meta.url), "utf8");
  const normalize = (value) => value.replace(/\s+/g, "").replace(/;$/, "");
  assert.equal(normalize(source.match(/`([^`]+)`/)[1]), normalize(patch));
  await f.db.prepare("ALTER TABLE address_delete_operations ADD COLUMN drift TEXT").run();
  const before = await snapshot();
  assert.equal((await f.request("/address_deletion_capability", b.token)).status, 503);
  assert.equal((await f.request("/address_deletions", b.token, input(b))).status, 503);
  assert.deepEqual(await snapshot(), before);
  await f.db.prepare("ALTER TABLE address_delete_operations DROP COLUMN drift").run();
  await f.migrate(); assert.equal((await f.request("/address_deletion_capability", b.token)).status, 200);
});
