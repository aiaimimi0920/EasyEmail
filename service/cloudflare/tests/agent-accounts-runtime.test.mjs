import assert from "node:assert/strict";
import { test } from "node:test";
import { newKey } from "./runtime-harness.mjs";
import { AGENT_PASSWORD, agentAccountInput as input, agentAccountsFixture, agentWrite, agentDelete, expect } from "./agent-accounts-fixture.mjs";

test("Agent accounts have a separate private namespace, encrypted credentials and immutable original-key receipts", async () => {
  const t = await agentAccountsFixture(), { h, alice, bob } = t;
  try {
    const id = crypto.randomUUID(), key = crypto.randomUUID(), route = `/api/v1/agent-accounts/${id}`;
    const created = expect(await agentWrite(h, alice, id, input, key), 201);
    assert.equal(created.operation.accountId, id); assert.equal(created.operation.revision, 1);
    const account = expect(await h.request(route, { cookie: alice.cookie })).account;
    assert.equal(account.scope, "agent"); assert.equal(account.kind, "agent_owned");
    assert.equal(account.emailAddress, "agent@example.test"); assert.equal(account.credentialConfigured, true);
    assert.equal(JSON.stringify(account).includes(AGENT_PASSWORD), false);
    const row = await h.db.prepare("SELECT * FROM agent_accounts WHERE id=?").bind(id).first();
    assert.ok(row.credential_cipher); assert.equal(JSON.stringify(row).includes(AGENT_PASSWORD), false);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM normal_accounts").first("n"), 0);
    assert.equal(expect(await h.request("/api/v1/normal-accounts", { cookie: alice.cookie })).items.length, 0);
    assert.equal((await h.request(`/api/v1/normal-accounts/${id}`, { cookie: alice.cookie })).status, 404);
    assert.equal((await h.request(route, { cookie: bob.cookie })).status, 404);
    const changed = { ...input, expectedRevision: 1, password: undefined, displayName: "新版", enabled: false };
    expect(await agentWrite(h, alice, id, changed));
    const replay = expect(await agentWrite(h, alice, id, input, key));
    assert.equal(replay.replayed, true); assert.deepEqual(replay.operation, created.operation);
    assert.equal(replay.account, undefined);
    assert.equal(expect(await h.request(route, { cookie: alice.cookie })).account.displayName, "新版");
    const receipt = expect(await h.request(`/api/v1/agent-account-operations/${key}`, { cookie: alice.cookie }));
    assert.deepEqual(receipt.operation, created.operation);
    assert.equal(JSON.stringify(receipt).includes(AGENT_PASSWORD), false); assert.equal(JSON.stringify(receipt).includes("example.test"), false);
    assert.equal((await agentWrite(h, alice, id, { ...input, password: "Changed-synthetic-secret" }, key)).status, 409);
    expect(await agentDelete(h, alice, id, 2));
    const tombstone = await h.db.prepare("SELECT * FROM agent_accounts WHERE id=?").bind(id).first();
    assert.equal(tombstone.credential_cipher, null); assert.equal(tombstone.email_address, ""); assert.equal(tombstone.username, "");
    assert.equal((await h.request(route, { cookie: alice.cookie })).status, 404);
    assert.equal((await agentWrite(h, alice, id, { ...input, expectedRevision: 3 })).status, 404);
    expect(await agentWrite(h, alice, crypto.randomUUID()), 201);
    await h.restart(); assert.deepEqual(expect(await agentWrite(h, alice, id, input, key)).operation, created.operation);
  } finally { await t.close(); }
});

test("Agent read/write/test scopes are independent of services, ordinary mail, keys and browser Origin", async () => {
  const t = await agentAccountsFixture(), { h, alice, bob } = t;
  try {
    const id = crypto.randomUUID(), path = `/api/v1/agent-accounts/${id}`;
    for (const scopes of [["mail-accounts:read", "mail-accounts:write", "mail-accounts:sync"], ["agent-services:read", "agent-services:write"]]) {
      const key = await newKey(h, alice.cookie, { scopes });
      assert.equal((await h.request("/api/v1/agent-accounts", { token: key.token })).status, 403);
      assert.equal((await agentWrite(h, alice, id, input, undefined, { token: key.token, cookie: undefined })).status, 403);
    }
    const read = await newKey(h, alice.cookie, { scopes: ["agent-accounts:read"] });
    assert.deepEqual(expect(await h.request("/api/v1/agent-accounts/endpoints", { token: read.token })).items.map(row => [row.id, row.authentication ?? "password"]),
      [["example", "password"], ["google", "google-oauth2"]]);
    assert.equal((await agentWrite(h, alice, id, input, undefined, { token: read.token, cookie: undefined })).status, 403);
    assert.equal((await agentWrite(h, alice, id, input, undefined, { origin: "https://hostile.invalid" })).status, 403);
    const writeOnly = await newKey(h, alice.cookie, { scopes: ["agent-accounts:write"] });
    assert.equal((await agentWrite(h, alice, id, input, undefined, { token: writeOnly.token, cookie: undefined, origin: null })).status, 403);
    const key = await newKey(h, alice.cookie, { scopes: ["agent-accounts:read", "agent-accounts:write"] });
    expect(await agentWrite(h, alice, id, input, undefined, { token: key.token, cookie: undefined, origin: null }), 201);
    assert.equal((await h.request(`${path}/test`, { method: "POST", token: key.token, body: { expectedRevision: 1 } })).status, 403);
    assert.equal((await h.request("/api/v1/normal-accounts", { token: key.token })).status, 403);
    assert.equal((await h.request("/api/v1/agent-services", { token: key.token })).status, 403);
    assert.equal((await h.request("/api/v1/api-keys", { token: key.token })).status, 403);
    assert.equal((await agentWrite(h, bob, id)).status, 409);
    assert.equal(expect(await h.request("/api/v1/agent-accounts", { cookie: bob.cookie })).items.length, 0);
  } finally { await t.close(); }
});

test("even identical IDs, external addresses and request keys remain separate normal and Agent namespaces", async () => {
  const t = await agentAccountsFixture(), { h, alice } = t;
  try {
    const id = crypto.randomUUID(), key = crypto.randomUUID(); expect(await agentWrite(h, alice, id, input, key), 201);
    const normalPath = `/api/v1/normal-accounts/${id}`, agentPath = `/api/v1/agent-accounts/${id}`;
    const save = body => h.request(normalPath, { method: "PUT", cookie: alice.cookie, headers: { "idempotency-key": key }, body });
    const normal = { ...input, displayName: "普通独立配置", password: "Other-ordinary-synthetic-password" };
    expect(await save(normal), 201);
    assert.equal(expect(await h.request(normalPath, { cookie: alice.cookie })).account.displayName, normal.displayName);
    assert.equal(expect(await h.request(agentPath, { cookie: alice.cookie })).account.displayName, input.displayName);
    const rows = await Promise.all(["normal_accounts", "agent_accounts"].map(table => h.db.prepare(`SELECT credential_cipher FROM ${table} WHERE id=?`).bind(id).first("credential_cipher")));
    assert.notEqual(rows[0], rows[1]);
    expect(await h.request(normalPath, { method: "DELETE", cookie: alice.cookie, headers: { "idempotency-key": crypto.randomUUID() }, body: { expectedRevision: 1 } }));
    const agent = expect(await h.request(agentPath, { cookie: alice.cookie })).account;
    assert.equal(agent.revision, 1); assert.equal(agent.credentialConfigured, true);
    assert.equal(expect(await agentWrite(h, alice, id, input, key)).replayed, true);
  } finally { await t.close(); }
});

test("Agent keyed request receipts replay across supported key rotation and fail closed after required key removal", async () => {
  const t = await agentAccountsFixture(), { h, alice } = t;
  try {
    const id = crypto.randomUUID(), key = crypto.randomUUID(), original = expect(await agentWrite(h, alice, id, input, key), 201);
    const before = await h.db.prepare("SELECT * FROM agent_accounts WHERE id=?").bind(id).first();
    const digest = await h.db.prepare("SELECT request_hash FROM agent_account_operations WHERE request_key=?").bind(key).first("request_hash");
    assert.match(digest, /^k1\.[a-f0-9]{64}$/);
    await h.restart({ MAILBOX_KEYRING: JSON.stringify({ active: "k2", keys: { k1: "c5".repeat(32), k2: "d6".repeat(32) } }) });
    assert.deepEqual(expect(await agentWrite(h, alice, id, input, key)).operation, original.operation);
    await h.restart({ MAILBOX_KEYRING: JSON.stringify({ active: "k2", keys: { k2: "d6".repeat(32) } }) });
    expect(await agentWrite(h, alice, id, input, key), 503);
    assert.deepEqual(await h.db.prepare("SELECT * FROM agent_accounts WHERE id=?").bind(id).first(), before);
    expect(await h.request(`/api/v1/agent-account-operations/${key}`, { cookie: alice.cookie }));
    expect(await agentWrite(h, alice, id, { ...input, expectedRevision: 1, password: "Replacement-synthetic-secret" }));
    const row = await h.db.prepare("SELECT credential_cipher FROM agent_accounts WHERE id=?").bind(id).first();
    assert.equal(JSON.parse(row.credential_cipher).key, "k2");
  } finally { await t.close(); }
});
