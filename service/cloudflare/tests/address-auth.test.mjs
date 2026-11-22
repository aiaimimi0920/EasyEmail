import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { sign } from "hono/jwt";
import { readFile } from "node:fs/promises";
import { addressAuthFixture, authSecret } from "./address-auth-fixture.mjs";
let f;
before(async () => { f = await addressAuthFixture(); }, { timeout: 90000 });
after(async () => { await f?.close(); }, { timeout: 15000 });

test("real Hono HS256 accepts current number and canonical string IDs; the production middleware is wired to the guard", async () => {
  for (const format of ["number", "string"]) {
    const b = await f.box(format); await f.seed(b.address, b.id);
    const result = await f.call("/mails", b.token);
    assert.equal(result.status, 200); assert.equal(result.body.results[0].address, b.address);
    assert.equal((await f.call("/address_deletion_capability", b.token)).status, 200);
  }
  const source = await readFile(new URL("../../../upstreams/cloudflare_temp_email/worker/src/worker.ts", import.meta.url), "utf8");
  assert.match(source, /jwt\(\{ secret: c\.env\.JWT_SECRET, alg: "HS256" \}\)\(c, async \(\) => \{\s+c\.res = await withAddressGeneration/);
});

test("a signed old-generation JWT cannot read or send through the same-name replacement", async () => {
  const b = await f.box(); await f.seed(b.address, b.id); await f.replace(b);
  assert.equal((await f.call("/mails", b.token)).status, 403);
  assert.equal((await f.call("/send_mail", b.token, { method: "POST", body: {} })).status, 403);
  assert.equal((await f.call("/delete_address", b.token, { method: "DELETE" })).status, 403);
  assert.equal((await f.db.prepare("SELECT n FROM fixture_dispatch_counter").first()).n, 0);
  assert.equal((await f.db.prepare("SELECT n FROM fixture_external_counter").first()).n, 0);
  assert.ok(await f.db.prepare("SELECT id FROM raw_mails WHERE id=?").bind(b.id).first());
});

test("unsigned/wrong-signature tokens remain 401 and signed invalid generation claims fail closed with 403", async () => {
  const b = await f.box();
  for (const token of ["", "unsigned", await sign(b.claims, "wrong-synthetic-secret", "HS256")]) {
    assert.equal((await f.call("/mails", token)).status, 401);
  }
  for (const address_id of [undefined, null, 0, -1, 1.5, "01", "1e0", " 1", "9007199254740992", {}, true]) {
    const token = await sign({ address: b.address, address_id }, authSecret, "HS256");
    assert.equal((await f.call("/mails", token)).status, 403, JSON.stringify(address_id));
    assert.equal((await f.call("/address_deletions", token, { method: "POST", body: {} })).status, 403);
  }
  for (const claims of [{ address_id: b.id }, { address: "", address_id: b.id }, { address: "other@example.test", address_id: b.id }]) {
    assert.equal((await f.call("/mails", await sign(claims, authSecret, "HS256"))).status, 403);
  }
});

test("D1 auth failures are sanitized 503 and never dispatch the protected operation", async () => {
  const b = await f.box(), count = (await f.db.prepare("SELECT n FROM fixture_dispatch_counter").first()).n;
  await f.db.prepare("ALTER TABLE address RENAME TO fixture_unavailable_address").run();
  try {
    const result = await f.call("/send_mail", b.token, { method: "POST", body: {} });
    assert.equal(result.status, 503); assert.deepEqual(result.body, { error: { code: "address_auth_storage_unavailable" } });
    assert.equal((await f.db.prepare("SELECT n FROM fixture_dispatch_counter").first()).n, count);
  } finally { await f.db.prepare("ALTER TABLE fixture_unavailable_address RENAME TO address").run(); }
});

test("patched Hono rejects expired, future and nonnumeric NumericDate claims before protected dispatch", async () => {
  const b = await f.box(), now = Math.floor(Date.now() / 1000);
  const values = [{ exp: now - 1 }, { nbf: now + 3600 }, { iat: now + 3600 }];
  for (const claim of ["exp", "nbf", "iat"]) for (const value of [String(now + 3600), "not-a-number", null, true, {}]) values.push({ [claim]: value });
  for (const value of values) {
    const token = await sign({ ...b.claims, ...value }, authSecret, "HS256");
    assert.equal((await f.call("/send_mail", token, { method: "POST", body: {} })).status, 401, JSON.stringify(value));
  }
  const token = await sign({ ...b.claims, exp: now + 3600, nbf: now - 1, iat: now - 1 }, authSecret, "HS256");
  assert.equal((await f.call("/mails", token)).status, 200);
  assert.equal((await f.db.prepare("SELECT n FROM fixture_dispatch_counter").first()).n, 0);
});

test("GET results are discarded if the generation changes during handler I/O; business errors are not recoded as auth success", async () => {
  const b = await f.box(); await f.seed(b.address, b.id);
  assert.equal((await f.call("/fixture/handler_error", b.token)).status, 500);
  const result = await f.call("/fixture/late_read", b.token);
  assert.equal(result.status, 403); assert.deepEqual(result.body, { error: { code: "mailbox_generation_changed" } });
});

test("old signed generations may reconcile only exact address operations and their own mail receipts after address deletion", async () => {
  const b = await f.box(), other = await f.box(); await f.seed(b.address, b.id);
  const mailId = crypto.randomUUID(), requestId = crypto.randomUUID();
  const expectedVersion = (await f.db.prepare("SELECT version FROM raw_mail_resources WHERE mail_id=?").bind(b.id).first()).version;
  const mail = await f.call("/mail_deletions", b.token, { method: "POST", body: { requestId: mailId, mailId: String(b.id), expectedVersion } });
  assert.equal(mail.status, 200);
  const input = { requestId, address: b.address, addressId: String(b.id) };
  const deleted = await f.call("/address_deletions", b.token, { method: "POST", body: input });
  assert.equal(deleted.status, 200); assert.equal(deleted.body.operation.state, "deleted");
  const replacement = await f.db.prepare("INSERT INTO address(name) VALUES(?) RETURNING id").bind(b.address).first(); await f.seed(b.address, b.id);
  const replacementToken = await sign({ address: b.address, address_id: replacement.id }, authSecret, "HS256");
  assert.deepEqual(await f.call(`/address_deletions/${requestId}`, b.token), deleted);
  assert.deepEqual(await f.call("/address_deletions", b.token, { method: "POST", body: input }), deleted);
  assert.deepEqual(await f.call(`/mail_deletions/${mailId}`, b.token), mail);
  assert.equal((await f.call(`/mail_deletions/${mailId}`, other.token)).status, 404);
  assert.equal((await f.call(`/address_deletions/${requestId}`, other.token)).status, 404);
  assert.equal((await f.call(`/mail_deletions/${mailId}`, replacementToken)).status, 404);
  assert.equal((await f.call(`/address_deletions/${requestId}`, replacementToken)).status, 404);
  assert.equal((await f.call(`/address_deletions/${requestId}`, b.token, { method: "HEAD" })).status, 200);
  assert.equal((await f.call("/address_deletions", b.token, { method: "POST", body: { ...input, requestId: crypto.randomUUID() } })).body.operation.state, "changed");
  for (const route of ["/mails", "/address_deletion_capability", "/address_deletions", "/address_deletions/bad",
    `/address_deletions/${requestId}/extra`, `/mail_deletions/${mailId}/extra`, `/address_deletions/${requestId}%2Fextra`]) {
    assert.equal((await f.call(route, b.token)).status, 403, route);
  }
  for (const route of ["/mail_deletions", `/address_deletions/${requestId}`, "/address_deletions/extra"]) {
    assert.equal((await f.call(route, b.token, { method: "POST", body: {} })).status, 403, route);
  }
  assert.ok(await f.db.prepare("SELECT id FROM raw_mails WHERE id=?").bind(b.id).first());
});
