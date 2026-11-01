import assert from "node:assert/strict";
import { test } from "node:test";
import { newKey } from "./runtime-harness.mjs";
import { normalFixture, normalInput } from "./normal-imap-fixture.mjs";
import { agentWrite, expect } from "./agent-accounts-fixture.mjs";

test("Agent uses the real read-only IMAP protocol with independent vault/lease/results and never populates normal storage", async () => {
  const t = await normalFixture(), { h, alice } = t;
  try {
    const id = t.id, path = `/api/v1/agent-accounts/${id}`;
    expect(await agentWrite(h, alice, id, normalInput), 201);
    const result = expect(await h.request(`${path}/test`, { cookie: alice.cookie, method: "POST", body: { expectedRevision: 1 } }));
    assert.equal(result.test.inbox.messages, 99); assert.equal(result.account.scope, "agent");
    assert.equal(t.opens.length, 1); assert.ok(t.calls.some(line => / EXAMINE INBOX$/.test(line)));
    assert.equal(t.calls.some(line => /SELECT|FETCH|STORE|EXPUNGE|APPEND/.test(line)), false);
    assert.equal(await h.db.prepare("SELECT tested_at FROM normal_accounts WHERE id=?").bind(t.id).first("tested_at"), null);
    const row = await h.db.prepare("SELECT * FROM agent_accounts WHERE id=?").bind(id).first();
    assert.equal(row.test_token, null); assert.equal(row.inbox_uid_validity, "42");
    t.mode("auth-reject"); const denied = await h.request(`${path}/test`, { cookie: alice.cookie, method: "POST", body: { expectedRevision: 1 } });
    expect(denied, 403); assert.equal(denied.text.includes("secret-server-text"), false);
    const ordinary = await h.db.prepare("SELECT credential_cipher FROM normal_accounts WHERE id=?").bind(t.id).first("credential_cipher");
    const agentCipher = await h.db.prepare("SELECT credential_cipher FROM agent_accounts WHERE id=?").bind(id).first("credential_cipher");
    await h.db.prepare("UPDATE agent_accounts SET credential_cipher=? WHERE id=?").bind(ordinary, id).run();
    const opens = t.opens.length;
    expect(await h.request(`${path}/test`, { cookie: alice.cookie, method: "POST", body: { expectedRevision: 1 } }), 503);
    assert.equal(t.opens.length, opens, "normal ciphertext must fail Agent AAD before socket open");
    await h.db.prepare("UPDATE normal_accounts SET credential_cipher=? WHERE id=?").bind(agentCipher, t.id).run();
    expect(await t.test(), 503); assert.equal(t.opens.length, opens, "Agent ciphertext must fail normal AAD before socket open");
  } finally { await t.close(); }
});

test("Agent late IMAP results cannot overwrite a newer configuration or write after API key revocation", async () => {
  const t = await normalFixture(), { h, alice } = t; let gate, pending;
  try {
    const id = crypto.randomUUID(), path = `/api/v1/agent-accounts/${id}`;
    expect(await agentWrite(h, alice, id, normalInput), 201);
    gate = t.hold(); pending = h.request(`${path}/test`, { cookie: alice.cookie, method: "POST", body: { expectedRevision: 1 } }); await gate.entered;
    expect(await h.request(`${path}/test`, { cookie: alice.cookie, method: "POST", body: { expectedRevision: 1 } }), 409);
    expect(await agentWrite(h, alice, id, { ...normalInput, expectedRevision: 1, enabled: false, password: undefined }));
    gate.release(); expect(await pending, 409); pending = null;
    let row = await h.db.prepare("SELECT * FROM agent_accounts WHERE id=?").bind(id).first();
    assert.equal(row.tested_at, null); assert.equal(row.test_token, null); assert.equal(row.revision, 2);
    expect(await agentWrite(h, alice, id, { ...normalInput, expectedRevision: 2 }));
    const key = await newKey(h, alice.cookie, { scopes: ["agent-accounts:read", "agent-accounts:sync"] });
    gate = t.hold(); pending = h.request(`${path}/test`, { token: key.token, origin: null, method: "POST", body: { expectedRevision: 3 } }); await gate.entered;
    await h.db.prepare("UPDATE api_keys SET revoked_at=unixepoch() WHERE id=?").bind(key.id).run();
    gate.release(); expect(await pending, 409); pending = null;
    row = await h.db.prepare("SELECT * FROM agent_accounts WHERE id=?").bind(id).first();
    assert.equal(row.tested_at, null); assert.equal(row.test_error, null); assert.equal(row.test_token, null);
  } finally { gate?.release(); await pending?.catch(() => {}); await t.close(); }
});

test("Agent expired or superseded IMAP leases cannot write results or clear a successor lease", async () => {
  const t = await normalFixture(), { h, alice } = t; let gate, pending;
  try {
    const id = crypto.randomUUID(), path = `/api/v1/agent-accounts/${id}/test`; expect(await agentWrite(h, alice, id, normalInput), 201);
    for (const mode of ["expired", "superseded", "disabled-user"]) {
      await h.resetLimits(); gate = t.hold(); pending = h.request(path, { cookie: alice.cookie, method: "POST", body: { expectedRevision: 1 } }); await gate.entered;
      if (mode === "disabled-user") await h.db.prepare("UPDATE users SET status='disabled' WHERE id=?").bind(alice.id).run();
      else if (mode === "expired") await h.db.prepare("UPDATE agent_accounts SET test_lease_until=0 WHERE id=?").bind(id).run();
      else await h.db.prepare("UPDATE agent_accounts SET test_token='successor',test_lease_until=unixepoch()+45 WHERE id=?").bind(id).run();
      gate.release(); expect(await pending, 409); pending = null;
      const row = await h.db.prepare("SELECT tested_at,test_error,test_token FROM agent_accounts WHERE id=?").bind(id).first();
      assert.equal(row.tested_at, null); assert.equal(row.test_error, null);
      assert.equal(row.test_token, mode === "superseded" ? "successor" : null);
      await h.db.prepare("UPDATE users SET status='active' WHERE id=?").bind(alice.id).run();
      await h.db.prepare("UPDATE agent_accounts SET test_token=NULL,test_lease_until=NULL WHERE id=?").bind(id).run();
    }
  } finally { gate?.release(); await pending?.catch(() => {}); await t.close(); }
});
