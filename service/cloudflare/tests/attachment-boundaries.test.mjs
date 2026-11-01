import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createHarness } from "./runtime-harness.mjs";
import { allocate, providerFixture } from "./provider-fixture.mjs";
import { attachmentMail, binaryRequest, bytesHash, downloadPath } from "./attachment-fixture.mjs";

let h, f, user, box;
const sync = () => h.request(`/api/v1/mailboxes/${box.id}/sync`, { method: "POST", cookie: user.cookie, body: {} });
const list = () => h.request(`/api/v1/mailboxes/${box.id}/messages`, { cookie: user.cookie });
const detail = (message) => h.request(`/api/v1/mailboxes/${box.id}/messages/${message.id}`, { cookie: user.cookie });
before(async () => { f = await providerFixture(); h = await createHarness(f.bindings);
  user = await h.register("attachment-limits-alice"); box = (await allocate(h, user.cookie)).body.mailbox; });
beforeEach(async () => { await h.resetLimits(); f.modes.clear(); });
after(async () => { await h?.close(); await f?.close(); });

test("legacy and oversized attachments stay metadata-only; invalid digest/index/size fails the entire sync", async () => {
  const fixture = attachmentMail(box.address);
  for (const metadata of [{ ...fixture.parsed.attachments[0], sha256: undefined },
    { ...fixture.parsed.attachments[0], size: 5 * 1024 * 1024 + 1 }]) {
    f.messages.set(box.address, [{ ...fixture.parsed, attachments: [metadata] }]);
    assert.equal((await sync()).status, 200);
    const rows = (await list()).body.items;
    const message = rows.find((item) => item.subject === fixture.parsed.subject && item.id);
    // All versions in this test are metadata-only; none may fetch raw MIME.
    for (const item of rows) {
      assert.equal((await detail(item)).body.message.attachments[0].downloadAvailable, false);
      const calls = f.calls.length;
      assert.equal((await binaryRequest(h, downloadPath(box, item), user.cookie)).status, 409);
      assert.equal(f.calls.length, calls);
    }
    assert.ok(message);
  }
  const count = (await h.db.prepare("SELECT COUNT(*) AS n FROM messages").first()).n;
  for (const changed of [{ sha256: "invalid" }, { sha256: "AB".repeat(32) }, { index: 1 }, { size: -1 }, { size: 1.5 }]) {
    f.messages.set(box.address, [{ ...fixture.parsed, attachments: [{ ...fixture.parsed.attachments[0], ...changed }] }]);
    assert.equal((await sync()).body.error.code, "provider_invalid_response");
    assert.equal((await h.db.prepare("SELECT COUNT(*) AS n FROM messages").first()).n, count);
  }
});

test("empty binary attachment survives restart; user download limit rejects before another provider fetch", async () => {
  const fixture = attachmentMail(box.address, Buffer.alloc(0));
  f.messages.set(box.address, [fixture.parsed]); f.rawMails.set(box.address, [fixture.raw]);
  assert.equal((await sync()).status, 200);
  const rows = (await list()).body.items;
  let message;
  for (const item of rows) if ((await detail(item)).body.message.attachments[0].size === 0) message = item;
  assert.ok(message); await h.restart();
  const calls = f.calls.length;
  for (let index = 0; index < 10; index++) {
    const result = await binaryRequest(h, downloadPath(box, message), user.cookie);
    assert.equal(result.status, 200, result.bytes.toString()); assert.equal(result.bytes.length, 0);
  }
  // Downloads may cross a fixed-minute boundary. Prepare the threshold explicitly, including the adjacent bucket.
  const minute = Math.floor(Date.now() / 60000);
  await h.db.batch([minute, minute + 1].map(bucket => h.db.prepare(`INSERT INTO auth_rate_limits(bucket,attempts,expires_at)
    VALUES (?,10,?) ON CONFLICT(bucket) DO UPDATE SET attempts=10`)
    .bind(bytesHash(Buffer.from(`attachment-download:${bucket}:${user.id}`)), (bucket + 3) * 60)));
  assert.equal((await binaryRequest(h, downloadPath(box, message), user.cookie)).status, 429);
  assert.equal(f.calls.length, calls + 10);
});

test("metadata truncation is explicit, and MIME nesting, part-count and header limits reject without returning bytes", async () => {
  const fixture = attachmentMail(box.address);
  f.messages.set(box.address, [{ ...fixture.parsed,
    attachments: Array.from({ length: 102 }, (_, index) => ({ ...fixture.parsed.attachments[0], index })) }]);
  assert.equal((await sync()).status, 200);
  const rows = (await list()).body.items;
  let message;
  for (const item of rows) if ((await detail(item)).body.message.attachmentsTruncated) message = item;
  assert.ok(message);
  assert.equal((await detail(message)).body.message.attachments.length, 100);
  assert.equal((await binaryRequest(h, downloadPath(box, message, 100), user.cookie)).status, 404);
  const nested = (index) => index === 34 ? "Content-Type: text/plain\r\n\r\nleaf" :
    `Content-Type: multipart/mixed; boundary="b${index}"\r\n\r\n--b${index}\r\n${nested(index + 1)}\r\n--b${index}--\r\n`;
  const parts = `Content-Type: multipart/mixed; boundary="parts"\r\n\r\n${"--parts\r\nContent-Type: text/plain\r\n\r\na\r\n".repeat(201)}--parts--\r\n`;
  for (const raw of [nested(0), parts, `X-Long: ${"x".repeat(256 * 1024)}\r\n\r\nbody`]) {
    f.rawMails.set(box.address, [{ ...fixture.raw, raw }]);
    const response = await binaryRequest(h, downloadPath(box, message), user.cookie);
    assert.equal(response.status, 502, response.bytes.toString());
    assert.equal(JSON.parse(response.bytes).error.code, "attachment_parse_failed");
  }
});
