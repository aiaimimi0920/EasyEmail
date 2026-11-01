import assert from "node:assert/strict";
import { test } from "node:test";
import { upstreamFixture, mime } from "./upstream-fixture.mjs";
import { createHarness } from "./runtime-harness.mjs";
import { allocate } from "./provider-fixture.mjs";
import { sendBody, sendRequest } from "./send-fixture.mjs";
import { assetMetadata, assetRef, bytesHash, putAsset } from "./outbox-fixture.mjs";

test("two complete Workers preserve To/CC/BCC, 2 MiB exact binary and real source threading in one structured binding call", { timeout: 120000 }, async () => {
  const f = await upstreamFixture({ E2E_TEST_MODE: "false", SEND_MAIL_DOMAINS: '["cf.example.test"]' }, true); let h;
  try {
    const config = JSON.parse(f.bindings.PROVIDER_CONFIG);
    Object.assign(config[0], { sendTransport: "binding", sendRecipients: ["*"] });
    h = await createHarness({ ...f.bindings, PROVIDER_CONFIG: JSON.stringify(config) }, false, null, null, { r2Buckets: { OUTBOX: "upstream-outbox" } });
    const alice = await h.register("upstream-multi-send"), box = (await allocate(h, alice.cookie)).body.mailbox;
    const raw = mime(box.address).replace(/Message-ID: [^\r]+/, "Message-ID: <real-source@example.test>");
    assert.equal((await f.deliver(box.address, raw)).rejectReason, undefined);
    assert.equal((await h.request(`/api/v1/mailboxes/${box.id}/sync`, { cookie: alice.cookie, method: "POST", body: {} })).status, 200);
    const source = (await h.request(`/api/v1/mailboxes/${box.id}/messages`, { cookie: alice.cookie })).body.items[0];
    const bytes = new Uint8Array(2097152).map((_, index) => index % 251), metadata = assetMetadata(bytes);
    const created = await h.request("/api/v1/outbox-attachments", { method: "POST", cookie: alice.cookie, body: metadata, headers: { "idempotency-key": crypto.randomUUID() } });
    assert.equal(created.status, 201, created.text);
    const uploaded = await putAsset(h, alice, created.body.attachment.id, bytes); assert.equal(uploaded.status, 200, uploaded.text);
    const key = crypto.randomUUID(), body = { ...sendBody, to: ["visible@example.test"], cc: ["copy@example.test"],
      bcc: ["hidden@example.test"], replyToMessageId: source.id, attachments: [assetRef(uploaded.body.attachment)] };
    const result = await sendRequest(h, alice.cookie, box, key, body); assert.equal(result.status, 201, result.text);
    assert.equal(f.sent.length, 1); const { attachments, ...sent } = f.sent[0];
    assert.deepEqual(sent, { from: box.address, to: body.to, cc: body.cc, bcc: body.bcc, subject: body.subject, text: body.text,
      headers: { "In-Reply-To": "<real-source@example.test>", References: "<real-source@example.test>" } });
    assert.equal(attachments.length, 1); assert.equal(attachments[0].filename, metadata.filename);
    assert.equal(attachments[0].type, metadata.mimeType); assert.equal(attachments[0].disposition, "attachment");
    const actual = new Uint8Array(Buffer.from(attachments[0].content, "base64")); assert.deepEqual(actual, bytes); assert.equal(bytesHash(actual), metadata.sha256);
    assert.equal(result.body.outgoing.delivery, "unconfirmed");
    await h.restart(); assert.equal((await sendRequest(h, alice.cookie, box, key, body)).status, 200);
    assert.equal(f.sent.length, 1); assert.deepEqual(f.externalRequests, []);
    console.log(`Structured binding capture only, not public delivery: ${f.directory}`);
  } finally { try { await h?.close(); } finally { await f.close(); } }
});
