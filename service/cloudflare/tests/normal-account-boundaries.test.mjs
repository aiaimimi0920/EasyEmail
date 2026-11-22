import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness, newKey, seedMailbox } from "./runtime-harness.mjs";
import { normalFixture, normalInput } from "./normal-imap-fixture.mjs";

test("normal account mutation and operation receipt commit atomically; competing revisions never overwrite", async () => {
  const t = await normalFixture();
  try {
    const id = crypto.randomUUID(), path = `/api/v1/normal-accounts/${id}`, key = crypto.randomUUID();
    const save = (body, requestKey = key, target = path) => t.h.request(target, { method: "PUT", cookie: t.alice.cookie,
      headers: { "idempotency-key": requestKey }, body });
    const body = { ...normalInput, emailAddress: "atomic@example.test" };
    await t.h.db.exec("CREATE TRIGGER fail_normal_insert BEFORE INSERT ON normal_accounts BEGIN SELECT RAISE(ABORT,'synthetic transaction failure'); END");
    assert.equal((await save(body)).status, 503);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_account_operations WHERE request_key=?").bind(key).first("n"), 0);
    await t.h.db.exec("DROP TRIGGER fail_normal_insert");
    const same = await Promise.all([save(body), save(body)]); assert.deepEqual(same.map(r => r.status).sort(), [200, 201]);
    const edits = await Promise.all([save({ ...body, expectedRevision: 1, displayName: "first" }, crypto.randomUUID()),
      save({ ...body, expectedRevision: 1, displayName: "second" }, crypto.randomUUID())]);
    assert.deepEqual(edits.map(r => r.status).sort(), [200, 409]);
    assert.equal((await t.h.request(path, { cookie: t.alice.cookie })).body.account.revision, 2);
  } finally { await t.close(); }
});

test("normal account keyed request hashes survive supported key rotation without storing guessable password hashes", async () => {
  const t = await normalFixture();
  try {
    const id = crypto.randomUUID(), path = `/api/v1/normal-accounts/${id}`, key = crypto.randomUUID();
    const body = { ...normalInput, emailAddress: "rotation@example.test" };
    const put = () => t.h.request(path, { method: "PUT", cookie: t.alice.cookie, headers: { "idempotency-key": key }, body });
    assert.equal((await put()).status, 201);
    const digest = await t.h.db.prepare("SELECT request_hash FROM normal_account_operations WHERE request_key=?").bind(key).first("request_hash");
    assert.match(digest, /^k1\.[0-9a-f]{64}$/);
    await t.h.restart({ MAILBOX_KEYRING: JSON.stringify({ active: "k2", keys: { k1: "c5".repeat(32), k2: "f6".repeat(32) } }) });
    assert.equal((await put()).body.replayed, true);
    await t.h.restart({ MAILBOX_KEYRING: JSON.stringify({ active: "k2", keys: { k2: "f6".repeat(32) } }) });
    assert.equal((await put()).body.error.code, "mailbox_vault_unavailable");
  } finally { await t.close(); }
});

test("user invalidation fences authenticated discovery and does not write late mailbox identity or test results", async () => {
  const t = await normalFixture(), gate = t.hold(); let pending;
  try {
    pending = t.test(); await gate.entered;
    await t.h.db.prepare("UPDATE users SET status='disabled' WHERE id=?").bind(t.alice.id).run();
    gate.release(); const result = await pending; pending = null; assert.equal(result.status, 409);
    const row = await t.h.db.prepare("SELECT tested_at,test_error,inbox_uid_validity,test_token FROM normal_accounts WHERE id=?").bind(t.id).first();
    assert.equal(row.tested_at, null); assert.equal(row.test_error, null); assert.equal(row.inbox_uid_validity, null); assert.equal(row.test_token, null);
  } finally { gate.release(); if (pending) await pending; await t.close(); }
});

test("0023 expands without changing temporary mail, outgoing guard, identity or old API key bytes", async () => {
  const h = await createHarness({}, false, "0022_send_jobs.sql");
  try {
    const alice = await h.register("normal-upgrade-alice"); await seedMailbox(h, alice.id, "existing@example.test");
    await newKey(h, alice.cookie, { scopes: ["mailboxes:read", "messages:read"] });
    const before = {};
    for (const table of ["users", "sessions", "api_keys", "mailboxes", "messages", "outgoing_messages", "send_jobs"]) before[table] = (await h.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='normal_accounts'").first("n"), 0);
    await h.migrate(); await h.migrate();
    for (const [table, rows] of Object.entries(before)) assert.deepEqual((await h.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results, rows, table);
    assert.deepEqual((await h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await h.close(); }
});

for (const mutation of ["expired-lease", "successor-claim"]) {
  test(`late authenticated discovery cannot persist results after ${mutation}`, async () => {
    const t = await normalFixture(), gate = t.hold(); let pending;
    try {
      pending = t.test(); await gate.entered;
      if (mutation === "expired-lease") await t.h.db.prepare("UPDATE normal_accounts SET test_lease_until=unixepoch()-1 WHERE id=?").bind(t.id).run();
      else await t.h.db.prepare("UPDATE normal_accounts SET test_token='successor-claim',test_lease_until=unixepoch()+45 WHERE id=?").bind(t.id).run();
      gate.release(); assert.equal((await pending).status, 409); pending = null;
      const row = await t.h.db.prepare("SELECT tested_at,test_error,inbox_uid_validity,test_token FROM normal_accounts WHERE id=?").bind(t.id).first();
      assert.equal(row.tested_at, null); assert.equal(row.test_error, null); assert.equal(row.inbox_uid_validity, null);
      assert.equal(row.test_token, mutation === "successor-claim" ? "successor-claim" : null);
    } finally { gate.release(); if (pending) await pending; await t.close(); }
  });
}

test("endpoint policy rejects private destinations, non-TLS ports and malformed configuration before connection", async () => {
  const h = await createHarness();
  try {
    const alice = await h.register("normal-endpoint-alice");
    for (const endpoint of [{ hostname: "127.0.0.1", port: 993 }, { hostname: "mail.local", port: 993 }, { hostname: "host.internal", port: 993 }, { hostname: "mail.home.arpa", port: 993 },
      { hostname: "imap.example.test", port: 143 }, { hostname: "imap.example.test:993", port: 993 }, { hostname: "IMAP.example.test", port: 993 }]) {
      await h.restart({ IMAP_ENDPOINTS: JSON.stringify([{ id: "example", label: "bad", ...endpoint }]) });
      const result = await h.request("/api/v1/normal-accounts/endpoints", { cookie: alice.cookie });
      assert.equal(result.status, 503); assert.equal(result.body.error.code, "imap_endpoints_unavailable");
    }
  } finally { await h.close(); }
});

for (const quota of ["active", "lifetime"]) {
  test(`normal account ${quota} quota fences concurrent creates but permits edits and original-key recovery`, async () => {
    const t = await normalFixture();
    try {
      const count = quota === "active" ? 18 : 98;
      await t.h.db.batch(Array.from({ length: count }, (_, index) => t.h.db.prepare(`INSERT INTO normal_accounts
        (id,user_id,email_address,display_name,endpoint_id,endpoint_hash,username,credential_cipher,enabled,revision,created_at,updated_at,deleted_at)
        SELECT ?,user_id,?,display_name,endpoint_id,endpoint_hash,username,NULL,0,1,created_at,updated_at,? FROM normal_accounts WHERE id=?`)
        .bind(crypto.randomUUID(), `quota-${index}@example.test`, quota === "active" ? null : 1, t.id)));
      const requests = [0, 1].map(index => ({ id: crypto.randomUUID(), key: crypto.randomUUID(),
        body: { ...normalInput, emailAddress: `candidate-${index}@example.test` } }));
      const save = row => t.h.request(`/api/v1/normal-accounts/${row.id}`, { method: "PUT", cookie: t.alice.cookie,
        headers: { "idempotency-key": row.key }, body: row.body });
      const results = await Promise.all(requests.map(save));
      assert.deepEqual(results.map(row => row.status).sort(), [201, 409]);
      const won = results.findIndex(row => row.status === 201), lost = 1 - won;
      assert.equal((await save(requests[won])).body.replayed, true);
      assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_account_operations WHERE request_key=?").bind(requests[lost].key).first("n"), 0);
      assert.equal(await t.h.db.prepare(`SELECT COUNT(*) n FROM normal_accounts WHERE user_id=? ${quota === "active" ? "AND deleted_at IS NULL" : ""}`)
        .bind(t.alice.id).first("n"), quota === "active" ? 20 : 100);
      const edit = await t.h.request(t.path, { method: "PUT", cookie: t.alice.cookie, headers: { "idempotency-key": crypto.randomUUID() },
        body: { ...normalInput, expectedRevision: 1, password: undefined, displayName: "Still editable at quota" } });
      assert.equal(edit.status, 200, edit.text);
    } finally { await t.close(); }
  });
}
