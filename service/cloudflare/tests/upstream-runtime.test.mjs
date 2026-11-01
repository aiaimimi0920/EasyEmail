import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { upstreamFixture, mime } from "./upstream-fixture.mjs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildLocalWorker } from "../../../upstreams/cloudflare_temp_email/worker/scripts/build-local.mjs";

let f;
before(async () => { f = await upstreamFixture(); }, { timeout: 90000 });
after(async () => { await f?.close(); }, { timeout: 20000 });

test("local build refuses relative paths and never clears an existing bundle", async () => {
  await assert.rejects(buildLocalWorker("relative-output"), /absolute isolated/);
  const file = path.join(f.directory, "bundle/worker.js"), before = await readFile(file);
  await assert.rejects(buildLocalWorker(f.directory), /EEXIST/);
  assert.deepEqual(await readFile(file), before);
});

test("Windows fixture checks the longer SQLite journal suffix before starting a Worker", async () => {
  if (process.platform !== "win32") return;
  const root = process.env.EASYEMAIL_TEST_ROOT;
  const suffix = path.join("upstream-XXXXXX", "state/d1/miniflare-D1DatabaseObject", "a".repeat(64) + ".sqlite-journal");
  const oversizedRoot = path.join(root, "x".repeat(260 - root.length - suffix.length - 2));
  assert.equal(path.join(oversizedRoot, suffix).length, 260);
  try {
    process.env.EASYEMAIL_TEST_ROOT = oversizedRoot;
    await assert.rejects(upstreamFixture(), /shorter EASYEMAIL_TEST_ROOT/);
  } finally { process.env.EASYEMAIL_TEST_ROOT = root; }
});

test("complete production entry mounts health, public settings and both authentication layers", async () => {
  const health = await f.request("/health_check", { site: false });
  assert.equal(health.status, 200); assert.equal(health.text, "OK");
  assert.equal((await f.request("/open_api/settings", { site: false })).status, 200);
  assert.equal((await f.request("/mail/snapshot", { site: false })).status, 401);
  assert.equal((await f.request("/admin/new_address", { method: "POST", body: {} })).status, 401);
  assert.equal((await f.request("/api/mails?limit=10&offset=0", { token: "invalid" })).status, 401);
});

test("real creation, MIME receive, database storage and raw/parsed APIs agree", async () => {
  const box = await f.create(), raw = mime(box.address);
  assert.equal((await f.receive(box.address, raw)).body.success, true);
  const stored = await f.db.prepare("SELECT * FROM raw_mails WHERE address=?").bind(box.address).first();
  assert.equal(stored.raw, raw); assert.equal(stored.raw_blob, null);
  const result = await f.request("/api/parsed_mails?limit=10&offset=0", { token: box.jwt });
  assert.equal(result.status, 200, result.text); assert.equal(result.body.results.length, 1);
  const mail = result.body.results[0];
  assert.equal(mail.subject, "Verify complete worker"); assert.match(mail.text, /485723/);
  assert.match(mail.resource_version, /^[0-9a-f]{32}$/); assert.equal(mail.remote_delete_enabled, true);
  assert.equal((await f.request(`/api/parsed_mail/${mail.id}`, { token: box.jwt })).body.subject, mail.subject);
  assert.equal((await f.request(`/api/mail/${mail.id}`, { token: box.jwt })).body.raw, raw);
  const other = await f.create();
  assert.equal((await f.request(`/api/parsed_mail/${mail.id}`, { token: other.jwt })).body, null);
});

test("storage errors reject receipt instead of reporting accepted mail", async () => {
  const box = await f.create();
  await f.db.prepare("CREATE TRIGGER fail_receive BEFORE INSERT ON raw_mails BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END").run();
  try {
    const result = await f.receive(box.address);
    assert.equal(result.body.success, false, result.text);
    assert.match(result.body.rejected, /Failed save message/);
    assert.match((await f.deliver(box.address)).rejectReason, /Failed save message/);
    assert.equal(await f.db.prepare("SELECT id FROM raw_mails WHERE address=?").bind(box.address).first(), null);
  } finally { await f.db.prepare("DROP TRIGGER fail_receive").run(); }
});

test("full entry conditional mail/address deletion keeps receipts and revokes an old generation", async () => {
  const box = await f.create(); await f.receive(box.address);
  const mail = (await f.request("/api/parsed_mails?limit=10&offset=0", { token: box.jwt })).body.results[0];
  const requestId = crypto.randomUUID(), body = { requestId, mailId: String(mail.id), expectedVersion: mail.resource_version };
  const remove = () => f.request("/api/mail_deletions", { method: "POST", token: box.jwt, body });
  const result = await remove(); assert.equal(result.body.operation.state, "deleted", result.text);
  assert.deepEqual((await remove()).body, result.body);
  assert.deepEqual((await f.request(`/api/mail_deletions/${requestId}`, { token: box.jwt })).body, result.body);
  assert.equal(await f.db.prepare("SELECT mail_id FROM raw_mail_resources WHERE mail_id=?").bind(mail.id).first(), null);
  const addressRequestId = crypto.randomUUID();
  const deleted = await f.request("/api/address_deletions", { method: "POST", token: box.jwt,
    body: { requestId: addressRequestId, address: box.address, addressId: String(box.id) } });
  assert.equal(deleted.body.operation.state, "deleted", deleted.text);
  const next = await f.create(box.address.split("@")[0]); assert.notEqual(next.id, box.id);
  await f.receive(next.address);
  assert.equal((await f.request("/api/mails?limit=10&offset=0", { token: box.jwt })).status, 403);
  assert.equal((await f.request("/api/mails?limit=10&offset=0", { token: next.jwt })).body.results.length, 1);
  assert.deepEqual((await f.request(`/api/address_deletions/${addressRequestId}`, { token: box.jwt })).body, deleted.body);
});
