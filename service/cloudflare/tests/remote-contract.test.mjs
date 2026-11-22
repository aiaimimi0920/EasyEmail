import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createHarness } from "./runtime-harness.mjs";
import { allocate } from "./provider-fixture.mjs";
import { remoteFixture } from "./remote-fixture.mjs";
import { readFile } from "node:fs/promises";

let f, h, alice, box, token;
const version = async (id) => (await f.db.prepare("SELECT version FROM raw_mail_resources WHERE mail_id=?").bind(id).first())?.version;
before(async () => {
  f = await remoteFixture(); h = await createHarness(f.bindings); alice = await h.register("remote-contract-alice");
  box = (await allocate(h, alice.cookie)).body.mailbox;
  token = (await f.db.prepare("SELECT token FROM fixture_credentials WHERE address=?").bind(box.address).first()).token;
}, { timeout: 90000 });
after(async () => { await h?.close(); await f?.close(); }, { timeout: 15000 });

test("resource generations cover inserts/updates/ID reuse, preserve legacy rows and repeat migration", async () => {
  await f.seed(box.address, 1); const first = await version(1); assert.match(first, /^[0-9a-f]{32}$/);
  await f.migrate(); assert.equal(await version(1), first);
  await f.db.prepare("UPDATE raw_mails SET raw=raw WHERE id=1").run(); assert.notEqual(await version(1), first);
  const changed = await version(1); await f.db.prepare("DELETE FROM raw_mails WHERE id=1").run();
  assert.equal(await version(1), undefined); await f.seed(box.address, 1); assert.notEqual(await version(1), changed);
  const listed = await f.request("/parsed_mails?limit=10&offset=0", token);
  assert.equal(listed.body.results[0].resource_version, await version(1));
});

test("conditional delete is atomic, version-fenced, durable and never deletes a reused integer ID", async () => {
  const old = await version(1), requestId = crypto.randomUUID();
  const input = { requestId, mailId: "1", expectedVersion: old };
  const result = await f.request("/mail_deletions", token, input);
  assert.equal(result.status, 200); assert.equal(result.body.operation.state, "deleted");
  assert.equal(await f.db.prepare("SELECT id FROM raw_mails WHERE id=1").first(), null);
  await f.seed(box.address, 1); const next = await version(1); assert.notEqual(next, old);
  assert.equal((await f.request("/mail_deletions", token, input)).body.operation.state, "deleted");
  assert.equal(await version(1), next);
  assert.equal((await f.request(`/mail_deletions/${requestId}`, token)).body.operation.state, "deleted");
  const stale = await f.request("/mail_deletions", token, { ...input, requestId: crypto.randomUUID() });
  assert.equal(stale.body.operation.state, "changed"); assert.equal(await version(1), next);
  assert.equal((await f.request("/mail_deletions", token, { ...input, expectedVersion: next })).status, 409);
});

test("mailbox-generation ownership, disable gate and failure rollback are enforced by actual upstream handlers", async () => {
  const other = (await allocate(h, alice.cookie)).body.mailbox;
  const otherToken = (await f.db.prepare("SELECT token FROM fixture_credentials WHERE address=?").bind(other.address).first()).token;
  const input = { requestId: crypto.randomUUID(), mailId: "1", expectedVersion: await version(1) };
  assert.equal((await f.request("/mail_deletions", otherToken, input)).body.operation.state, "absent");
  assert.ok(await version(1));
  await f.db.prepare("UPDATE fixture_settings SET enabled=0").run();
  assert.equal((await f.request("/mail_deletions", token, input)).status, 403);
  await f.db.prepare("UPDATE fixture_settings SET enabled=1").run();
  await f.db.prepare("CREATE TRIGGER fail_delete BEFORE DELETE ON raw_mails BEGIN SELECT RAISE(ABORT,'synthetic'); END").run();
  try { assert.equal((await f.request("/mail_deletions", token, input)).status, 503); }
  finally { await f.db.prepare("DROP TRIGGER fail_delete").run(); }
  assert.ok(await version(1));
  assert.equal(await f.db.prepare("SELECT request_id FROM mail_delete_operations WHERE request_id=? AND address=?")
    .bind(input.requestId, box.address).first(), null);
  await f.db.prepare("DELETE FROM address WHERE name=?").bind(box.address).run();
  await f.db.prepare("INSERT INTO address(name) VALUES(?)").bind(box.address).run();
  assert.equal((await f.request("/mail_deletions", token, input)).status, 403);
  console.log(`M3j upstream contract evidence: ${f.directory}`);
});

test("missing/drifted triggers fail closed and SQL migration preserves versions and matches fresh schema", async () => {
  const next = (await allocate(h, alice.cookie)).body.mailbox;
  const auth = (await f.db.prepare("SELECT token FROM fixture_credentials WHERE address=?").bind(next.address).first()).token;
  await f.seed(next.address, 20); const old = await version(20), body = { requestId: crypto.randomUUID(), mailId: "20", expectedVersion: old };
  await f.db.prepare("DROP TRIGGER raw_mail_resource_update").run();
  await f.db.prepare("UPDATE raw_mails SET raw=json_set(raw,'$.subject','Changed while trigger missing') WHERE id=20").run();
  assert.equal(await version(20), old);
  const list = await f.request("/parsed_mails?limit=10&offset=0", auth);
  assert.equal(list.body.results[0].resource_version, undefined); assert.equal(list.body.results[0].remote_delete_enabled, false);
  assert.equal((await f.request("/mail_deletions", auth, body)).status, 503);
  await f.db.prepare("CREATE TRIGGER raw_mail_resource_update AFTER UPDATE ON raw_mails BEGIN SELECT 1; END").run();
  assert.equal((await f.request("/mail_deletions", auth, body)).status, 503);
  const guards = (await f.db.prepare("SELECT * FROM mail_delete_operations ORDER BY address_id,request_id").all()).results;
  await f.db.prepare("DROP TRIGGER raw_mail_resource_update").run(); await f.migrate();
  assert.notEqual(await version(20), old);
  assert.deepEqual((await f.db.prepare("SELECT * FROM mail_delete_operations ORDER BY address_id,request_id").all()).results, guards);
  assert.equal((await f.request("/mail_deletions", auth, body)).body.operation.state, "changed");
  const repaired = await version(20); await f.migrate(); assert.equal(await version(20), repaired);
  const schema = await readFile(new URL("../../../upstreams/cloudflare_temp_email/db/schema.sql", import.meta.url), "utf8");
  const patch = await readFile(new URL("../../../upstreams/cloudflare_temp_email/db/2026-10-28-mail-resources.sql", import.meta.url), "utf8");
  assert.ok(schema.includes(patch.trimEnd()));
  // Fresh schema and the TS-driven admin migration must produce the same readiness contract.
  const source = await readFile(new URL("../../../upstreams/cloudflare_temp_email/worker/src/mails_api/mail_resource_schema.ts", import.meta.url), "utf8");
  const sql = [...source.split("] as const;")[0].matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  const normalize = (value) => value.replace(/\s+/g, "").replace(/;$/, "");
  assert.deepEqual(sql.map(normalize), patch.trim().split(/\r?\n\s*\r?\n/).map(normalize));
});

test("concurrent conflicting bodies cannot delete the losing resource; disabled replay and absent are truthful", async () => {
  const next = (await allocate(h, alice.cookie)).body.mailbox;
  const auth = (await f.db.prepare("SELECT token FROM fixture_credentials WHERE address=?").bind(next.address).first()).token;
  await f.seed(next.address, 21); await f.seed(next.address, 22); const requestId = crypto.randomUUID();
  const outcomes = await Promise.all([21, 22].map(async (id) => f.request("/mail_deletions", auth,
    { requestId, mailId: String(id), expectedVersion: await version(id) })));
  assert.deepEqual(outcomes.map((row) => row.status).sort(), [200, 409]);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM raw_mails WHERE id IN (21,22)").first()).n, 1);
  const winner = outcomes.find((row) => row.status === 200).body.operation;
  await f.db.prepare("UPDATE fixture_settings SET enabled=0").run();
  assert.equal((await f.request("/mail_deletions", auth,
    { requestId, mailId: winner.mailId, expectedVersion: winner.expectedVersion })).body.operation.state, "deleted");
  assert.equal((await f.request(`/mail_deletions/${requestId}`, auth)).body.operation.state, "deleted");
  await f.db.prepare("UPDATE fixture_settings SET enabled=1").run();
  const absent = await f.request("/mail_deletions", auth, { requestId: crypto.randomUUID(), mailId: "99999", expectedVersion: "a".repeat(32) });
  assert.equal(absent.body.operation.state, "absent");
});

test("upstream rejects malformed/oversized inputs without mutation and old schema still reads safely", async () => {
  const next = (await allocate(h, alice.cookie)).body.mailbox;
  const auth = (await f.db.prepare("SELECT token FROM fixture_credentials WHERE address=?").bind(next.address).first()).token;
  const body = { requestId: crypto.randomUUID(), mailId: "20", expectedVersion: "a".repeat(32) };
  for (const invalid of [{ ...body, mailId: "9007199254740992" }, { ...body, requestId: "bad" }, { ...body, extra: true },
    { ...body, expectedVersion: "A".repeat(32) }, null]) assert.equal((await f.request("/mail_deletions", auth, invalid)).status, 400);
  assert.equal((await f.request("/mail_deletions", auth, { ...body, extra: "a".repeat(9000) })).status, 413);
  assert.equal((await f.request(`/mail_deletions/${crypto.randomUUID()}`, auth)).status, 404);
  for (const name of ["insert", "update", "delete"]) await f.db.prepare(`DROP TRIGGER raw_mail_resource_${name}`).run();
  await f.db.prepare("DROP TABLE mail_delete_operations").run(); await f.db.prepare("DROP TABLE raw_mail_resources").run();
  assert.equal((await f.request("/mail_deletions", auth, body)).status, 503);
  await f.seed(next.address, 23);
  const list = await f.request("/parsed_mails?limit=10&offset=0", auth);
  assert.equal(list.status, 200); assert.equal(list.body.results[0].remote_delete_enabled, false);
  await f.migrate(); assert.match(await version(23), /^[0-9a-f]{32}$/);
});
