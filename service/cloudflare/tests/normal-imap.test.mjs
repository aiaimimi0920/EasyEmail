import assert from "node:assert/strict";
import { test } from "node:test";
import { normalFixture, normalInput, IMAP_PASSWORD } from "./normal-imap-fixture.mjs";

test("authenticated IMAP test is TLS-only and EXAMINE-only, with private persisted identity and fragmented responses", async () => {
  const t = await normalFixture();
  try {
    const result = await t.test(); assert.equal(result.status, 200, result.text);
    assert.deepEqual(result.body.test.inbox, { path: "INBOX", uidValidity: "42", messages: 99 });
    assert.equal(result.body.test.readOnly, true); assert.equal(result.body.test.authenticated, true);
    assert.equal(result.body.account.testError, null); assert.ok(result.body.account.testedAt);
    assert.equal(result.text.includes(IMAP_PASSWORD), false);
    assert.deepEqual(t.opens[0], { address: { hostname: "imap.example.test", port: 993 }, options: { secureTransport: "on", allowHalfOpen: false } });
    assert.deepEqual(t.calls.filter(line => line.startsWith("ee")).map(line => line.split(" ").slice(1).join(" ")), ["CAPABILITY", "AUTHENTICATE PLAIN", "EXAMINE INBOX", "LOGOUT"]);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM messages").first("n"), 0, "Connection success is not synchronization");
    await t.h.restart(); const account = await t.h.request(t.path, { cookie: t.alice.cookie });
    assert.equal(account.body.account.inboxUidValidity, "42"); assert.equal(account.body.account.inboxMessages, 99);
  } finally { await t.close(); }
});

test("server rejection and invalid INBOX identity are sanitized and do not become a successful test", async () => {
  const t = await normalFixture();
  try {
    assert.equal((await t.test()).status, 200);
    t.mode("auth-reject"); const auth = await t.test(); assert.equal(auth.status, 403, auth.text);
    assert.equal(auth.body.error.code, "imap_auth_failed"); assert.equal(auth.text.includes("secret-server-text"), false);
    const failed = (await t.h.request(t.path, { cookie: t.alice.cookie })).body.account;
    assert.equal(failed.testError, "imap_auth_failed");
    assert.equal(failed.inboxUidValidity, null, "A failed check must not retain a successful INBOX identity");
    assert.equal(failed.inboxMessages, null);
    t.mode("invalid-validity"); const invalid = await t.test(); assert.equal(invalid.status, 502, invalid.text);
    assert.equal(invalid.body.error.code, "imap_inbox_identity_missing");
  } finally { await t.close(); }
});

test("disable/credential revision changes fence a paused authenticated discovery result", async () => {
  const t = await normalFixture(), gate = t.hold(); let pending;
  try {
    pending = t.test(); await gate.entered;
    assert.equal((await t.test()).status, 409);
    const changed = await t.h.request(t.path, { method: "PUT", cookie: t.alice.cookie, headers: { "idempotency-key": crypto.randomUUID() },
      body: { ...normalInput, expectedRevision: 1, enabled: false, password: undefined } }); assert.equal(changed.status, 200, changed.text);
    gate.release(); const late = await pending; pending = null;
    assert.equal(late.status, 409); const row = (await t.h.request(t.path, { cookie: t.alice.cookie })).body.account;
    assert.equal(row.revision, 2); assert.equal(row.testedAt, null); assert.equal(row.inboxUidValidity, null);
    assert.equal((await t.test(2)).body.error.code, "normal_account_disabled");
  } finally { gate.release(); if (pending) await pending; await t.close(); }
});

test("changed endpoint and transplanted credential ciphertext fail before any network connection", async () => {
  const t = await normalFixture();
  try {
    await t.h.restart({ IMAP_ENDPOINTS: JSON.stringify([{ id: "example", label: "changed", hostname: "different.example.test", port: 993 }]) });
    assert.equal((await t.test()).body.error.code, "imap_endpoint_changed"); assert.equal(t.opens.length, 0);
    await t.h.restart({ IMAP_ENDPOINTS: t.bindings.IMAP_ENDPOINTS });
    const otherId = crypto.randomUUID();
    const second = await t.h.request(`/api/v1/normal-accounts/${otherId}`, { method: "PUT", cookie: t.alice.cookie,
      headers: { "idempotency-key": crypto.randomUUID() }, body: { ...normalInput, emailAddress: "other@example.test" } }); assert.equal(second.status, 201);
    await t.h.db.prepare("UPDATE normal_accounts SET credential_cipher=(SELECT credential_cipher FROM normal_accounts WHERE id=?) WHERE id=?").bind(otherId, t.id).run();
    assert.equal((await t.test()).body.error.code, "mailbox_credential_unavailable"); assert.equal(t.opens.length, 0);
  } finally { await t.close(); }
});

test("IMAP timeout closes the socket and releases the owned lease without extending deadlines", async () => {
  const t = await normalFixture(), gate = t.hold(); let pending;
  try {
    pending = t.test(); await gate.entered;
    const result = await pending; pending = null; assert.equal(result.status, 504, result.text);
    assert.equal(result.body.error.code, "imap_timeout"); gate.release();
    const row = await t.h.db.prepare("SELECT test_token,test_lease_until,test_error FROM normal_accounts WHERE id=?").bind(t.id).first();
    assert.equal(row.test_token, null); assert.equal(row.test_lease_until, null); assert.equal(row.test_error, "imap_timeout");
    assert.equal((await t.test()).status, 200);
  } finally { gate.release(); if (pending) await pending; await t.close(); }
});
