import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { addressAuthFixture } from "./address-auth-fixture.mjs";
let f;
before(async () => { f = await addressAuthFixture(); }, { timeout: 90000 });
after(async () => { await f?.close(); }, { timeout: 15000 });

test("legacy current-generation deletion commits all D1 cleanup and preserves unrelated data", async () => {
  const b = await f.box("string"), other = await f.box(); await f.seedRelated(b); await f.seedRelated(other);
  const before = await f.snapshot();
  assert.deepEqual(await f.call("/delete_address", b.token, { method: "DELETE" }), { status: 200, body: { success: true } });
  const after = await f.snapshot();
  for (const table of ["address", "raw_mails", "address_sender", "sendbox", "auto_reply_mails"]) {
    const key = table === "address" ? "name" : "address";
    assert.deepEqual(after[table], before[table].filter((row) => row[key] !== b.address), table);
  }
  assert.deepEqual(after.users_address, before.users_address.filter((row) => row.address_id !== b.id));
  assert.deepEqual(after.raw_mail_resources, before.raw_mail_resources.filter((row) => row.mail_id !== b.id));
  assert.equal((await f.call("/mails", b.token)).status, 403);
});

test("legacy cleanup keeps ID-only/name-only callers and rejects a supplied mismatched pair before external cleanup", async () => {
  const caller = await f.box();
  for (const shape of ["id", "name"]) {
    const b = await f.box(); await f.seedRelated(b);
    const body = shape === "id" ? { address_id: String(b.id) } : { address: b.address };
    assert.deepEqual(await f.call("/fixture/legacy_cleanup", caller.token, { method: "POST", body }), { status: 200, body: { success: true } });
    assert.equal(await f.db.prepare("SELECT id FROM address WHERE id=?").bind(b.id).first(), null);
    assert.equal(await f.db.prepare("SELECT id FROM raw_mails WHERE id=?").bind(b.id).first(), null);
  }
  const b = await f.box(), other = await f.box(); await f.seedRelated(b); const before = await f.snapshot();
  const count = (await f.db.prepare("SELECT n FROM fixture_external_counter").first()).n;
  const result = await f.call("/fixture/legacy_cleanup", caller.token, { method: "POST", body: { address: b.address, address_id: other.id } });
  assert.equal(result.status, 500); assert.deepEqual(await f.snapshot(), before);
  assert.equal((await f.db.prepare("SELECT n FROM fixture_external_counter").first()).n, count);
});

test("a legacy delete admitted before replacement cannot delete the new generation D1 data", async () => {
  const b = await f.box(); await f.seedRelated(b); const before = await f.snapshot();
  await f.mode("replace-before-cleanup");
  try {
    const response = await f.call("/delete_address", b.token, { method: "DELETE" });
    assert.ok(response.status >= 400);
    const after = await f.snapshot();
    for (const table of ["raw_mails", "raw_mail_resources", "address_sender", "sendbox", "auto_reply_mails"]) {
      assert.deepEqual(after[table], before[table], table);
    }
    const current = await f.db.prepare("SELECT id FROM address WHERE name=?").bind(b.address).first();
    assert.notEqual(current.id, b.id);
    assert.ok(await f.db.prepare("SELECT id FROM users_address WHERE address_id=?").bind(current.id).first());
    assert.ok(await f.db.prepare("SELECT id FROM users_address WHERE address_id=?").bind(b.id).first());
  } finally { await f.mode("normal"); }
});

test("a final address SQL failure rolls back all earlier D1 deletes; external failure leaves D1 untouched", async () => {
  const b = await f.box(); await f.seedRelated(b); const before = await f.snapshot();
  await f.db.prepare("CREATE TRIGGER fixture_fail_legacy_delete BEFORE DELETE ON address BEGIN SELECT RAISE(ABORT,'private synthetic SQL'); END").run();
  try {
    const result = await f.call("/delete_address", b.token, { method: "DELETE" });
    assert.equal(result.status, 500); assert.equal(JSON.stringify(result.body).includes("private synthetic SQL"), false);
    assert.deepEqual(await f.snapshot(), before);
  } finally { await f.db.prepare("DROP TRIGGER fixture_fail_legacy_delete").run(); }
  await f.mode("fail-before-cleanup");
  try {
    assert.equal((await f.call("/delete_address", b.token, { method: "DELETE" })).status, 500);
    assert.deepEqual(await f.snapshot(), before);
  } finally { await f.mode("normal"); }
  assert.equal((await f.call("/delete_address", b.token, { method: "DELETE" })).status, 200);
});
