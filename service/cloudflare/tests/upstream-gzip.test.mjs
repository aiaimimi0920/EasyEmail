import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { upstreamFixture, mime } from "./upstream-fixture.mjs";
import { attachmentMail, bytesHash } from "./attachment-fixture.mjs";

let f;
before(async () => { f = await upstreamFixture({ ENABLE_MAIL_GZIP: "true", ENABLE_AUTO_REPLY: "true", BLACK_LIST: "blocked@example.test" }); }, { timeout: 90000 });
after(async () => { await f?.close(); }, { timeout: 20000 });

test("gzip stores a BLOB while real raw/parsed endpoints preserve MIME and binary attachment digest", async () => {
  const box = await f.create(), fixture = attachmentMail(box.address, Buffer.from([0, 255, 128, 10, 13, 65]));
  assert.equal((await f.receive(box.address, fixture.raw.raw)).body.success, true);
  const stored = await f.db.prepare("SELECT * FROM raw_mails WHERE address=?").bind(box.address).first();
  assert.equal(stored.raw, null); assert.ok(stored.raw_blob.length);
  const raw = await f.request(`/api/mail/${stored.id}`, { token: box.jwt });
  assert.equal(raw.body.raw, fixture.raw.raw); assert.equal("raw_blob" in raw.body, false);
  const parsed = await f.request(`/api/parsed_mail/${stored.id}`, { token: box.jwt });
  assert.equal(parsed.body.subject, "Verify your account");
  assert.deepEqual(parsed.body.attachments, [{ filename: "报告.txt", mimeType: "application/octet-stream", disposition: "attachment",
    size: fixture.bytes.length, index: 0, sha256: bytesHash(fixture.bytes) }]);
});

test("auto reply uses the platform EmailMessage type; failed storage stops auto reply", async () => {
  const box = await f.create();
  await f.db.prepare("INSERT INTO auto_reply_mails(address,subject,message) VALUES(?,?,?)").bind(box.address, "Synthetic reply", "Local only").run();
  const accepted = await f.receive(box.address);
  assert.equal(accepted.body.success, true); assert.equal(accepted.body.replyCalled, true, accepted.text);
  await f.db.prepare("CREATE TRIGGER fail_gzip_receive BEFORE INSERT ON raw_mails BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END").run();
  try {
    const failed = await f.receive(box.address);
    assert.equal(failed.body.success, false); assert.equal(failed.body.replyCalled, false);
    assert.equal(await f.db.prepare("SELECT COUNT(*) n FROM raw_mails WHERE address=?").bind(box.address).first("n"), 1);
  } finally { await f.db.prepare("DROP TRIGGER fail_gzip_receive").run(); }
});

test("blacklist and unknown recipient rejection leave the complete database unchanged", async () => {
  const box = await f.create();
  const blocked = await f.receive(box.address, mime(box.address), "blocked@example.test");
  assert.equal(blocked.body.success, false); assert.equal(blocked.body.rejected, "Reject from address");
  assert.equal(await f.db.prepare("SELECT id FROM raw_mails WHERE address=?").bind(box.address).first(), null);
  await f.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('email_rule_settings',?)")
    .bind(JSON.stringify({ blockReceiveUnknowAddressEmail: true })).run();
  try {
    const unknown = await f.receive("unknown@cf.example.test");
    assert.equal(unknown.body.success, false); assert.equal(unknown.body.rejected, "Unknown address");
    assert.equal(await f.db.prepare("SELECT id FROM raw_mails WHERE address='unknown@cf.example.test'").first(), null);
  } finally { await f.db.prepare("DELETE FROM settings WHERE key='email_rule_settings'").run(); }
});
