import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { agentAccountsFixture, agentWrite, agentDelete, agentAccountInput as input, expect } from "./agent-accounts-fixture.mjs";

let t, h, alice;
before(async () => { t = await agentAccountsFixture(); ({ h, alice } = t); });
beforeEach(async () => h.resetLimits());
after(async () => t?.close());

test("Agent account input rejects identity injection, arbitrary hosts, Google/password mixing, invalid credentials and address reassignment", async () => {
  const id = crypto.randomUUID();
  for (const patch of [{ scope: "normal" }, { kind: "normal" }, { userId: alice.id }, { hostname: "127.0.0.1" }, { port: 143 },
    { password: undefined }, { password: "bad\0secret" }, { username: "user\r\nLOGOUT" }, { username: "\ud800" },
    { expectedRevision: -1 }, { expectedRevision: 1.5 }, { enabled: "yes" }, { emailAddress: "Name <x@example.test>" },
    { forgetCredential: true }, { password: "\ud800" }]) expect(await agentWrite(h, alice, id, { ...input, ...patch }), 400);
  expect(await agentWrite(h, alice, id, { ...input, endpointId: "google" }), 400);
  expect(await agentWrite(h, alice, id, { ...input, endpointId: "missing" }), 409);
  expect(await agentWrite(h, alice, id), 201);
  expect(await agentWrite(h, alice, id, { ...input, expectedRevision: 1, emailAddress: "different@example.test" }), 409);
  expect(await agentWrite(h, alice, id, { ...input, expectedRevision: 1, password: undefined, username: "changed" }), 409);
  expect(await agentWrite(h, alice, id, { ...input, expectedRevision: 1, password: undefined, enabled: false, forgetCredential: true }));
  assert.equal(await h.db.prepare("SELECT credential_cipher FROM agent_accounts WHERE id=?").bind(id).first("credential_cipher"), null);
  expect(await agentDelete(h, alice, id, 2));
});

test("Agent method/filter/body/key gates reject before durable reservation and pagination does not cross ownership", async () => {
  const id = crypto.randomUUID(), before = await h.db.prepare("SELECT COUNT(*) n FROM agent_account_operations").first("n");
  expect(await agentWrite(h, alice, id, input, "short"), 400);
  expect(await agentWrite(h, alice, id, input, undefined, { origin: null }), 403);
  expect(await agentWrite(h, alice, id, input, undefined, { headers: { "content-type": "text/plain" } }), 415);
  expect(await agentWrite(h, alice, id, { ...input, password: "x".repeat(9000) }), 413);
  for (const query of ["limit=0", "limit=101", "limit=1&limit=2", "cursor=bad", "scope=normal", "cursor=&cursor="]) {
    expect(await h.request(`/api/v1/agent-accounts?${query}`, { cookie: alice.cookie }), 400);
  }
  expect(await h.request("/api/v1/agent-accounts/endpoints?x=y", { cookie: alice.cookie }), 400);
  expect(await h.request(`/api/v1/agent-accounts/${id}`, { method: "PATCH", cookie: alice.cookie, body: {} }), 405);
  assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM agent_account_operations").first("n"), before);
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const itemId = crypto.randomUUID(); ids.push(itemId);
    expect(await agentWrite(h, alice, itemId, { ...input, emailAddress: `page-${i}@example.test` }), 201);
  }
  expect(await agentWrite(h, t.bob, crypto.randomUUID()), 201);
  const seen = []; let cursor = "";
  do {
    const page = expect(await h.request(`/api/v1/agent-accounts?limit=2${cursor ? `&cursor=${cursor}` : ""}`, { cookie: alice.cookie }));
    seen.push(...page.items.map(row => row.id)); cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, ids.sort());
});

test("Agent create/update/delete and their receipts all roll back on actual D1 completion failure", async () => {
  const id = crypto.randomUUID(); expect(await agentWrite(h, alice, id, { ...input, emailAddress: "rollback@example.test" }), 201);
  await h.db.prepare("CREATE TRIGGER agent_account_receipt_failure BEFORE UPDATE OF completed_at ON agent_account_operations BEGIN SELECT RAISE(ABORT,'private synthetic failure'); END").run();
  try {
    const operations = [() => agentWrite(h, alice, crypto.randomUUID(), { ...input, emailAddress: "not-created@example.test" }),
      () => agentWrite(h, alice, id, { ...input, emailAddress: "rollback@example.test", expectedRevision: 1, displayName: "Must rollback" }),
      () => agentDelete(h, alice, id, 1)];
    const count = await h.db.prepare("SELECT COUNT(*) n FROM agent_account_operations").first("n");
    for (const operation of operations) {
      const result = await operation(); expect(result, 503); assert.equal(result.body.error.code, "agent_account_storage_failed");
      assert.equal(result.text.includes("private synthetic failure"), false);
      assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM agent_account_operations").first("n"), count);
      assert.equal(await h.db.prepare("SELECT revision FROM agent_accounts WHERE id=?").bind(id).first("revision"), 1);
    }
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM agent_accounts WHERE email_address='not-created@example.test'").first("n"), 0);
  } finally { await h.db.prepare("DROP TRIGGER agent_account_receipt_failure").run(); }
});

test("Agent active/lifetime/receipt bounds preserve ordinary quotas and do not invalidate durable replay", async () => {
  const id = crypto.randomUUID(), key = crypto.randomUUID(), body = { ...input, emailAddress: "quota@example.test" };
  expect(await agentWrite(h, alice, id, body, key), 201);
  const active = await h.db.prepare("SELECT COUNT(*) n FROM agent_accounts WHERE user_id=? AND deleted_at IS NULL").bind(alice.id).first("n");
  for (let i = active; i < 20; i++) {
    await h.db.prepare(`INSERT INTO agent_accounts(id,user_id,email_address,display_name,endpoint_id,endpoint_hash,username,enabled,revision,created_at,updated_at)
      VALUES(?,? ,?,'quota','example','synthetic','Agent',0,1,0,0)`).bind(crypto.randomUUID(), alice.id, `quota-${i}@example.test`).run();
  }
  expect(await agentWrite(h, alice, crypto.randomUUID(), { ...input, emailAddress: "overflow@example.test" }), 409);
  await h.db.prepare("UPDATE agent_accounts SET deleted_at=0 WHERE user_id=? AND id<>?").bind(alice.id, id).run();
  const total = await h.db.prepare("SELECT COUNT(*) n FROM agent_accounts WHERE user_id=?").bind(alice.id).first("n");
  for (let i = total; i < 100; i++) await h.db.prepare(`INSERT INTO agent_accounts
    (id,user_id,email_address,display_name,endpoint_id,endpoint_hash,username,enabled,revision,created_at,updated_at,deleted_at)
    VALUES(?,?,'','','example','synthetic','',0,1,0,0,0)`).bind(crypto.randomUUID(), alice.id).run();
  expect(await agentWrite(h, alice, crypto.randomUUID(), { ...input, emailAddress: "overflow@example.test" }), 409);
  expect(await agentWrite(h, alice, id, { ...body, expectedRevision: 1, password: undefined, enabled: false }));
  const count = await h.db.prepare("SELECT COUNT(*) n FROM agent_account_operations WHERE user_id=?").bind(alice.id).first("n");
  await h.db.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<?)
    INSERT INTO agent_account_operations(user_id,request_key,id,account_id,request_hash,kind,revision,deleted,created_at,completed_at)
    SELECT ?, 'quota-'||n, 'quota-op-'||n, ?, 'synthetic','PUT',1,0,0,0 FROM seq`).bind(10000 - count, alice.id, id).run();
  expect(await agentDelete(h, alice, id, 2), 409);
  assert.equal(expect(await agentWrite(h, alice, id, body, key)).operation.revision, 1);
  const normal = await h.request(`/api/v1/normal-accounts/${crypto.randomUUID()}`, { method: "PUT", cookie: alice.cookie, body: input,
    headers: { "idempotency-key": crypto.randomUUID() } }); expect(normal, 201);
});
