import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { newKey } from "./runtime-harness.mjs";
import { selectGates } from "./account-race-fixture.mjs";
import { agentDelete, expect } from "./agent-accounts-fixture.mjs";
import { agentSmtpFixture, agentSmtpInput as input } from "./agent-smtp-fixture.mjs";

const entry = new URL("./account-gated-worker.ts", import.meta.url);
test("Agent SMTP CAS and same-key races have one effect and preserve immutable completion", async () => {
  const gates = await selectGates(); let t, ga, gb, a, b;
  try {
    t = await agentSmtpFixture({ bindings: gates.bindings, entry }); const { h, id } = t;
    ga = gates.hold("smtp-cas-a", "agent-smtp"); gb = gates.hold("smtp-cas-b", "agent-smtp");
    a = t.configure(input, undefined, { headers: ga.headers }); b = t.configure({ ...input, username: "Other" }, undefined, { headers: gb.headers });
    await Promise.all([ga.entered(), gb.entered()]); ga.release(); gb.release();
    const results = await Promise.all([a, b]); a = b = null; assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    assert.equal(await h.db.prepare("SELECT revision FROM agent_smtp_configs WHERE account_id=?").bind(id).first("revision"), 1);
    const key = crypto.randomUUID(), next = { ...input, smtpRevision: 1, enabled: false };
    const same = await Promise.all([t.configure(next, key), t.configure(next, key)]);
    same.forEach(r => expect(r)); assert.deepEqual(same[0].body.operation, same[1].body.operation);
    assert.equal(await h.db.prepare("SELECT revision FROM agent_smtp_configs WHERE account_id=?").bind(id).first("revision"), 2);
    ga = gates.hold("smtp-replay", "agent-smtp-operation");
    a = t.configure({ ...next, smtpRevision: 2, enabled: true }, key, { headers: ga.headers }); await ga.entered(); ga.release();
    expect(await a, 409); a = null;
  } finally { ga?.release(); gb?.release(); await a?.catch(() => {}); await b?.catch(() => {}); await t?.close(); await gates.close(); }
});

test("Agent SMTP reservation refuses late revoked/expired keys, sessions and disabled users", async () => {
  const gates = await selectGates(); let t, gate, pending;
  try {
    t = await agentSmtpFixture({ bindings: gates.bindings, entry }); const { h, alice, id } = t;
    for (const kind of ["key", "expiry", "session", "user"]) {
      const key = ["key", "expiry"].includes(kind) ? await newKey(h, alice.cookie, { scopes: ["agent-accounts:read", "agent-accounts:write"] }) : null;
      const op = crypto.randomUUID(); gate = gates.hold(`smtp-revoke-${kind}`, "agent-smtp");
      pending = t.configure(input, op, { headers: gate.headers, ...(key ? { token: key.token, origin: null } : {}) }); await gate.entered();
      if (key) await h.db.prepare(kind === "expiry" ? "UPDATE api_keys SET expires_at=0 WHERE id=?" : "UPDATE api_keys SET revoked_at=unixepoch() WHERE id=?").bind(key.id).run();
      else if (kind === "session") await h.db.prepare("UPDATE sessions SET revoked_at=unixepoch() WHERE token_hash=?")
        .bind(createHash("sha256").update(alice.cookie.split("=")[1]).digest("hex")).run();
      else await h.db.prepare("UPDATE users SET status='disabled' WHERE id=?").bind(alice.id).run();
      gate.release(); expect(await pending, 401); pending = null;
      assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM agent_smtp_operations WHERE request_key=?").bind(op).first("n"), 0);
      assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM agent_smtp_configs WHERE account_id=?").bind(id).first("n"), 0);
      if (kind === "session") await h.db.prepare("UPDATE sessions SET revoked_at=NULL WHERE user_id=?").bind(alice.id).run();
      if (kind === "user") await h.db.prepare("UPDATE users SET status='active' WHERE id=?").bind(alice.id).run();
    }
  } finally { gate?.release(); await pending?.catch(() => {}); await t?.close(); await gates.close(); }
});

test("Agent SMTP save and parent deletion are fenced in either commit order", async () => {
  const gates = await selectGates(); let t, gate, pending;
  try {
    t = await agentSmtpFixture({ bindings: gates.bindings, entry }); const { h, alice, id } = t;
    gate = gates.hold("smtp-save-before-delete", "agent-smtp"); pending = t.configure(input, undefined, { headers: gate.headers }); await gate.entered();
    expect(await agentDelete(h, alice, id, 1)); gate.release(); expect(await pending, 409); pending = null;
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM agent_smtp_configs WHERE account_id=?").bind(id).first("n"), 0);
  } finally { gate?.release(); await pending?.catch(() => {}); await t?.close(); await gates.close(); }
});

test("Agent SMTP write/completion failures roll back reservation and configuration together", async () => {
  const t = await agentSmtpFixture(), { h } = t;
  try {
    for (const [table, event] of [["agent_smtp_configs", "INSERT"], ["agent_smtp_operations", "UPDATE"]]) {
      await h.db.prepare(`CREATE TRIGGER fail_smtp BEFORE ${event} ON ${table} BEGIN SELECT RAISE(ABORT,'private synthetic failure'); END`).run();
      const result = await t.configure(); expect(result, 503); assert.equal(result.text.includes("private synthetic failure"), false);
      assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM agent_smtp_operations").first("n"), 0);
      assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM agent_smtp_configs").first("n"), 0);
      await h.db.prepare("DROP TRIGGER fail_smtp").run();
    }
    expect(await t.configure());
    await h.db.prepare("CREATE TRIGGER fail_retirement BEFORE UPDATE ON agent_smtp_configs BEGIN SELECT RAISE(ABORT,'private synthetic failure'); END").run();
    expect(await agentDelete(h, t.alice, t.id, 1), 503);
    assert.equal(await h.db.prepare("SELECT deleted_at FROM agent_accounts WHERE id=?").bind(t.id).first("deleted_at"), null);
    assert.ok(await h.db.prepare("SELECT credential_cipher FROM agent_smtp_configs WHERE account_id=?").bind(t.id).first("credential_cipher"));
  } finally { await t.close(); }
});
