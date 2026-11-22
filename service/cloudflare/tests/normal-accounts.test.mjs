import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness, newKey } from "./runtime-harness.mjs";

const bindings = {
  IMAP_ENDPOINTS: JSON.stringify([{ id: "example", label: "Test IMAP", hostname: "imap.example.test", port: 993 }]),
  MAILBOX_KEYRING: JSON.stringify({ active: "k1", keys: { k1: "c5".repeat(32) } }),
};
const password = "Synthetic-app-password-8593";
const input = { expectedRevision: 0, emailAddress: "Alice@example.test", displayName: "普通邮箱", endpointId: "example", username: "Alice", password, enabled: true };

test("private normal accounts encrypt credentials, persist revisions and replay one immutable operation", async () => {
  const h = await createHarness(bindings);
  try {
    const alice = await h.register("normal-config-alice"), bob = await h.register("normal-config-bob");
    const id = crypto.randomUUID(), key = crypto.randomUUID(), path = `/api/v1/normal-accounts/${id}`;
    const save = (body = input, requestKey = key) => h.request(path, { method: "PUT", cookie: alice.cookie, headers: { "idempotency-key": requestKey }, body });
    const created = await save(); assert.equal(created.status, 201, created.text);
    assert.equal(created.body.account.emailAddress, "alice@example.test"); assert.equal(created.body.account.revision, 1);
    assert.equal(created.body.account.credentialConfigured, true); assert.equal(created.text.includes(password), false);
    const row = await h.db.prepare("SELECT * FROM normal_accounts WHERE id=?").bind(id).first();
    assert.ok(row.credential_cipher); assert.equal(JSON.stringify(row).includes(password), false);
    const operation = await h.db.prepare("SELECT * FROM normal_account_operations WHERE request_key=?").bind(key).first();
    assert.equal(JSON.stringify(operation).includes(password), false);
    assert.equal((await save()).body.replayed, true);
    assert.equal((await save({ ...input, password: "Other-synthetic-password-7460" })).body.error.code, "idempotency_conflict");
    assert.equal((await h.request(path, { cookie: bob.cookie })).status, 404);
    assert.equal((await h.request("/api/v1/normal-accounts", { cookie: bob.cookie })).body.items.length, 0);
    // The same external address is private configuration, not a global temporary-address allocation.
    const other = await h.request(`/api/v1/normal-accounts/${crypto.randomUUID()}`, { method: "PUT", cookie: bob.cookie,
      headers: { "idempotency-key": crypto.randomUUID() }, body: input }); assert.equal(other.status, 201, other.text);
    const changed = await save({ ...input, expectedRevision: 1, displayName: "更新", password: undefined, enabled: false }, crypto.randomUUID());
    assert.equal(changed.status, 200, changed.text); assert.equal(changed.body.account.revision, 2);
    assert.equal((await save()).body.operation.revision, 1); assert.equal((await save()).body.account.displayName, "更新");
    assert.equal((await save({ ...input, expectedRevision: 1 }, crypto.randomUUID())).status, 409);
    await h.restart(); const restored = await h.request(path, { cookie: alice.cookie });
    assert.equal(restored.body.account.revision, 2); assert.equal(restored.body.account.enabled, false);
    const removed = await h.request(path, { method: "DELETE", cookie: alice.cookie,
      headers: { "idempotency-key": crypto.randomUUID() }, body: { expectedRevision: 2 } });
    assert.equal(removed.status, 200, removed.text);
    assert.equal((await h.db.prepare("SELECT credential_cipher FROM normal_accounts WHERE id=?").bind(id).first()).credential_cipher, null);
    assert.equal((await h.request(path, { cookie: alice.cookie })).status, 404);
    assert.equal((await save({ ...input, expectedRevision: 3 }, crypto.randomUUID())).status, 404);
  } finally { await h.close(); }
});

test("normal account scopes, Origin, endpoint allowlist and strict secret inputs fail closed", async () => {
  const h = await createHarness(bindings);
  try {
    const alice = await h.register("normal-policy-alice"), id = crypto.randomUUID(), path = `/api/v1/normal-accounts/${id}`;
    const old = await newKey(h, alice.cookie, { scopes: ["mailboxes:read", "mailboxes:write", "messages:read"] });
    assert.equal((await h.request("/api/v1/normal-accounts", { token: old.token })).status, 403);
    const read = await newKey(h, alice.cookie, { scopes: ["mail-accounts:read"] });
    assert.equal((await h.request("/api/v1/normal-accounts/endpoints", { token: read.token })).body.items[0].id, "example");
    const put = (body, extra = {}) => h.request(path, { method: "PUT", cookie: alice.cookie,
      headers: { "idempotency-key": crypto.randomUUID() }, body, ...extra });
    assert.equal((await put(input, { origin: "https://evil.invalid" })).status, 403);
    assert.equal((await put(input, { token: read.token, cookie: undefined })).status, 403);
    for (const body of [{ ...input, hostname: "127.0.0.1" }, { ...input, endpointId: "unknown" },
      { ...input, username: "alice\r\nLOGOUT" }, { ...input, password: "secret\0other" }, { ...input, expectedRevision: -1 },
      { ...input, password: undefined }, { ...input, enabled: "true" }, { ...input, username: "\ud800" }, { ...input, password: "\ud800" }]) {
      assert.ok((await put(body)).status >= 400);
    }
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM normal_accounts").first("n"), 0);
    assert.equal((await put(input)).status, 201);
    assert.equal((await h.request(`${path}/test`, { method: "POST", token: read.token, body: { expectedRevision: 1 } })).status, 403);
    const write = await newKey(h, alice.cookie, { scopes: ["mail-accounts:write"] });
    const program = await h.request(`/api/v1/normal-accounts/${crypto.randomUUID()}`, { method: "PUT", token: write.token, origin: null,
      headers: { "idempotency-key": crypto.randomUUID() }, body: { ...input, emailAddress: "program@example.test" } });
    assert.equal(program.status, 201, program.text);
  } finally { await h.close(); }
});
