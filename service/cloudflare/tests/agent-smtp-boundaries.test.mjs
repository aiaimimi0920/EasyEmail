import assert from "node:assert/strict";
import { test } from "node:test";
import { newKey } from "./runtime-harness.mjs";
import { agentWrite, agentAccountInput, expect } from "./agent-accounts-fixture.mjs";
import { agentSmtpFixture, agentSmtpInput as input } from "./agent-smtp-fixture.mjs";

test("Agent SMTP read/write is explicitly scoped and Origin-bound without granting normal sending or services", async () => {
  const t = await agentSmtpFixture(), { h, alice, route } = t;
  try {
    for (const scopes of [["mail-accounts:read", "mail-accounts:write", "mail-accounts:send"], ["agent-services:read", "agent-services:write"], ["agent-accounts:write"]]) {
      const key = await newKey(h, alice.cookie, { scopes });
      expect(await h.request(route, { token: key.token }), 403);
      expect(await t.configure(input, undefined, { token: key.token, cookie: undefined, origin: null }), 403);
    }
    const read = await newKey(h, alice.cookie, { scopes: ["agent-accounts:read"] });
    expect(await h.request(route, { token: read.token }));
    expect(await t.configure(input, undefined, { token: read.token, cookie: undefined }), 403);
    expect(await t.configure(input, undefined, { origin: "https://hostile.invalid" }), 403);
    expect(await t.configure(input, undefined, { origin: null }), 403);
    const write = await newKey(h, alice.cookie, { scopes: ["agent-accounts:read", "agent-accounts:write"] });
    expect(await t.configure(input, undefined, { token: write.token, cookie: undefined, origin: null }));
    expect(await h.request(`/api/v1/normal-accounts/${t.id}/smtp`, { token: write.token }), 403);
    expect(await h.request(`/api/v1/normal-accounts/${t.id}/send`, { method: "POST", token: write.token, body: {} }), 403);
    expect(await h.request(`/api/v1/agent-accounts/${t.id}/send`, { method: "POST", cookie: alice.cookie, body: {} }), 404);
  } finally { await t.close(); }
});

test("Agent SMTP rejects injected fields, mixed authentication, invalid revisions, query ambiguity and missing keys before writing", async () => {
  const t = await agentSmtpFixture();
  try {
    for (const patch of [{ scope: "normal" }, { userId: t.bob.id }, { hostname: "127.0.0.1" }, { authentication: "google-oauth2" },
      { expectedRevision: -1 }, { smtpRevision: 0.5 }, { smtpRevision: Number.MAX_SAFE_INTEGER }, { username: "bad\r\nAUTH PLAIN" },
      { password: "\ud800" }, { forgetCredential: true }, { enabled: "true" }]) expect(await t.configure({ ...input, ...patch }), 400);
    expect(await t.configure(input, "not-a-uuid"), 400);
    expect(await t.configure({ ...input, endpointId: "google" }), 400);
    expect(await t.configure({ ...input, endpointId: "not-configured" }), 409);
    for (const suffix of ["?q=secret", "?limit=1&limit=2"]) expect(await t.h.request(t.route + suffix, { cookie: t.alice.cookie }), 400);
    for (const method of ["POST", "PATCH", "DELETE"]) expect(await t.h.request(t.route, { method, cookie: t.alice.cookie, body: {} }), 405);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_smtp_configs").first("n"), 0);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_smtp_operations").first("n"), 0);
  } finally { await t.close(); }
});

test("Agent and normal SMTP can share account ID and original key but never configuration, credentials or lifecycle", async () => {
  const t = await agentSmtpFixture(), { h, alice, id } = t;
  try {
    const normal = `/api/v1/normal-accounts/${id}`, key = crypto.randomUUID();
    expect(await h.request(normal, { method: "PUT", cookie: alice.cookie, body: agentAccountInput, headers: { "idempotency-key": crypto.randomUUID() } }), 201);
    expect(await t.configure(input, key));
    expect(await h.request(`${normal}/smtp`, { method: "PUT", cookie: alice.cookie, body: { ...input, username: "Normal-only", password: "Other-synthetic-password" }, headers: { "idempotency-key": key } }));
    assert.equal(expect(await t.read()).smtp.username, input.username);
    assert.equal(expect(await h.request(`${normal}/smtp`, { cookie: alice.cookie })).smtp.username, "Normal-only");
    await h.db.prepare("UPDATE normal_accounts SET enabled=0,credential_cipher=NULL,revision=revision+1 WHERE id=?").bind(id).run();
    assert.equal(expect(await t.read()).smtp.credentialConfigured, true);
    expect(await agentWrite(h, alice, id, { ...agentAccountInput, expectedRevision: 1, password: undefined, enabled: false, forgetCredential: true }));
    const row = await h.db.prepare("SELECT * FROM agent_smtp_configs WHERE account_id=?").bind(id).first();
    assert.equal(row.credential_cipher, null); assert.equal(row.enabled, 0); assert.equal(row.username, "");
    assert.ok(await h.db.prepare("SELECT credential_cipher FROM normal_smtp_configs WHERE account_id=?").bind(id).first("credential_cipher"));
    assert.equal(expect(await t.configure(input, key)).replayed, true);
  } finally { await t.close(); }
});

test("Agent SMTP operation quota retains old receipts and never prevents atomic parent credential retirement", async () => {
  const t = await agentSmtpFixture(), { h, alice, id } = t;
  try {
    const key = crypto.randomUUID(), original = expect(await t.configure(input, key));
    await h.db.prepare(`INSERT INTO agent_smtp_operations(user_id,request_key,id,account_id,request_hash,account_revision,revision,created_at,completed_at)
      WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<9999)
      SELECT ?, 'quota-'||x, 'quota-'||x, ?, 'synthetic', 1, 1, 1, 1 FROM n`).bind(alice.id, id).run();
    expect(await t.configure({ ...input, smtpRevision: 1, enabled: false }), 409);
    assert.deepEqual(expect(await t.configure(input, key)).operation, original.operation);
    expect(await agentWrite(h, alice, id, { ...agentAccountInput, expectedRevision: 1, password: undefined, enabled: false, forgetCredential: true }));
    assert.equal(await h.db.prepare("SELECT credential_cipher FROM agent_smtp_configs WHERE account_id=?").bind(id).first("credential_cipher"), null);
  } finally { await t.close(); }
});

test("Agent SMTP revision saturation can never prevent parent removal or credential retirement", async () => {
  const t = await agentSmtpFixture(), { h, alice } = t;
  try {
    for (const removing of [true, false]) {
      const id = removing ? t.id : crypto.randomUUID();
      if (!removing) expect(await agentWrite(h, alice, id, { ...agentAccountInput, emailAddress: "saturated-second@example.test" }), 201);
      const path = `/api/v1/agent-accounts/${id}`;
      expect(await h.request(`${path}/smtp`, { cookie: alice.cookie, method: "PUT", body: input, headers: { "idempotency-key": crypto.randomUUID() } }));
      await h.db.prepare("UPDATE agent_smtp_configs SET revision=? WHERE account_id=?").bind(Number.MAX_SAFE_INTEGER, id).run();
      expect(await h.request(path, { cookie: alice.cookie, method: removing ? "DELETE" : "PUT", headers: { "idempotency-key": crypto.randomUUID() },
        body: removing ? { expectedRevision: 1 } : { ...agentAccountInput, emailAddress: "saturated-second@example.test", expectedRevision: 1, password: undefined, enabled: false, forgetCredential: true } }));
      const row = await h.db.prepare("SELECT * FROM agent_smtp_configs WHERE account_id=?").bind(id).first();
      assert.equal(row.revision, Number.MAX_SAFE_INTEGER); assert.equal(row.credential_cipher, null); assert.equal(row.enabled, 0); assert.equal(row.username, "");
      assert.equal(await h.db.prepare("SELECT revision FROM agent_accounts WHERE id=?").bind(id).first("revision"), 2);
    }
  } finally { await t.close(); }
});
