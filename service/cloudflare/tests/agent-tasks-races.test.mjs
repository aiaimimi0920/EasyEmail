import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { newKey } from "./runtime-harness.mjs";
import { selectGates } from "./account-race-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";
import { agentTasksFixture } from "./agent-tasks-fixture.mjs";

test("Agent task enqueue fences late service/account changes and revoked or expired interactive credentials atomically", async () => {
  const t = await agentTasksFixture(), gates = await selectGates(); let gate, pending;
  const { h, alice } = t;
  try {
    const account = await h.db.prepare("SELECT * FROM agent_accounts WHERE id=?").bind(t.accountId).first();
    for (const kind of ["service", "account", "smtp", "user", "session", "key", "expired-key"]) {
      gate = gates.hold(`enqueue-${kind}`); await h.restart({ TEST_AGENT_GATE: `${gates.bindings.TEST_SELECT_GATE}/enqueue-${kind}` });
      const token = kind.includes("key") ? await newKey(h, alice.cookie, { scopes: ["agent-tasks:read", "agent-tasks:send"] }) : null;
      pending = t.enqueue(t.input, undefined, { headers: { "x-test-agent-gate": "1" }, ...(token ? { token: token.token, origin: null } : {}) }); await gate.entered();
      if (kind === "service") await h.db.prepare("UPDATE agent_services SET version=version+1 WHERE user_id=? AND id=?").bind(alice.id, t.serviceId).run();
      if (kind === "account") await h.db.prepare("UPDATE agent_accounts SET revision=revision+1 WHERE id=?").bind(t.accountId).run();
      if (kind === "smtp") await h.db.prepare("UPDATE agent_smtp_configs SET revision=revision+1 WHERE account_id=?").bind(t.accountId).run();
      if (kind === "user") await h.db.prepare("UPDATE users SET status='disabled' WHERE id=?").bind(alice.id).run();
      if (kind === "session") await h.db.prepare("UPDATE sessions SET revoked_at=unixepoch() WHERE token_hash=?")
        .bind(createHash("sha256").update(alice.cookie.split("=")[1]).digest("hex")).run();
      if (token) await h.db.prepare(kind === "key" ? "UPDATE api_keys SET revoked_at=1 WHERE id=?" : "UPDATE api_keys SET expires_at=0 WHERE id=?").bind(token.id).run();
      gate.release(); expect(await pending, ["user", "session", "key", "expired-key"].includes(kind) ? 401 : 409); pending = null;
      for (const table of ["agent_threads", "agent_outgoing_messages", "agent_thread_messages", "agent_send_jobs"])
        assert.equal(await h.db.prepare(`SELECT COUNT(*) n FROM ${table}`).first("n"), 0, `${kind}: ${table}`);
      await h.db.prepare("UPDATE agent_services SET version=1 WHERE user_id=? AND id=?").bind(alice.id, t.serviceId).run();
      await h.db.prepare("UPDATE agent_accounts SET revision=1,credential_cipher=? WHERE id=?").bind(account.credential_cipher, t.accountId).run();
      await h.db.prepare("UPDATE agent_smtp_configs SET revision=1 WHERE account_id=?").bind(t.accountId).run();
      await h.db.prepare("UPDATE users SET status='active' WHERE id=?").bind(alice.id).run(); await h.db.prepare("UPDATE sessions SET revoked_at=NULL WHERE user_id=?").bind(alice.id).run();
    }
  } finally { gate?.release(); await pending?.catch(() => {}); await t.close(); await gates.close(); }
});

test("Agent dispatch rechecks service authorization at the reservation boundary; cancellation can win that race", async () => {
  const t = await agentTasksFixture(), gates = await selectGates(); let gate, pending;
  try {
    for (const kind of ["cancel", "service", "account"]) {
      const task = expect(await t.enqueue(), 201).task;
      gate = gates.hold(`dispatch-${kind}`); await t.h.restart({ TEST_AGENT_GATE: `${gates.bindings.TEST_SELECT_GATE}/dispatch-${kind}` });
      pending = t.run(); await gate.entered();
      if (kind === "cancel") expect(await t.h.request(`/api/v1/agent-tasks/${task.id}/cancel`, { method: "POST", cookie: t.alice.cookie, body: { expectedRevision: 1 } }));
      if (kind === "service") await t.h.db.prepare("UPDATE agent_services SET trust_level='blocked' WHERE user_id=? AND id=?").bind(t.alice.id, t.serviceId).run();
      if (kind === "account") await t.h.db.prepare("UPDATE agent_smtp_configs SET enabled=0 WHERE account_id=?").bind(t.accountId).run();
      gate.release(); await pending; pending = null;
      assert.equal(expect(await t.read(task.id)).task.state, kind === "cancel" ? "cancelled" : "failed"); assert.equal(t.opens.length, 0);
      await t.h.db.prepare("UPDATE agent_services SET trust_level='trusted' WHERE user_id=? AND id=?").bind(t.alice.id, t.serviceId).run();
      await t.h.db.prepare("UPDATE agent_smtp_configs SET enabled=1 WHERE account_id=?").bind(t.accountId).run();
    }
  } finally { gate?.release(); await pending?.catch(() => {}); await t.close(); await gates.close(); }
});

test("Concurrent Agent schedules share one SMTP guard; queued intent survives key revocation but not live user disable", async () => {
  const t = await agentTasksFixture();
  try {
    const key = await newKey(t.h, t.alice.cookie, { scopes: ["agent-tasks:read", "agent-tasks:send"] }), requestKey = crypto.randomUUID();
    const results = await Promise.all([t.enqueue(t.input, requestKey, { token: key.token }), t.enqueue(t.input, requestKey, { token: key.token })]);
    results.forEach(result => assert.ok([200, 201].includes(result.status), result.text)); assert.equal(results[0].body.task.id, results[1].body.task.id);
    await t.h.db.prepare("UPDATE api_keys SET revoked_at=1 WHERE id=?").bind(key.id).run();
    await Promise.all([t.run(), t.run()]); assert.equal(t.messages.length, 1);
    const other = expect(await t.enqueue(), 201).task; await t.h.db.prepare("UPDATE users SET status='disabled' WHERE id=?").bind(t.alice.id).run();
    await t.run(); assert.equal(t.messages.length, 1);
    assert.equal(await t.h.db.prepare("SELECT state FROM agent_outgoing_messages WHERE thread_id=?").bind(other.id).first("state"), "not_sent");
  } finally { await t.close(); }
});

test("Agent cancellation cannot win after the durable dispatch guard even while SMTP DATA is in flight", async () => {
  const t = await agentTasksFixture(); let pending, gate;
  try {
    const task = expect(await t.enqueue(), 201).task;
    gate = t.hold(); pending = t.run(); await gate.entered;
    const submitted = expect(await t.read(task.id)).task;
    assert.equal(submitted.state, "pending"); assert.equal(submitted.cancellable, false);
    expect(await t.h.request(`/api/v1/agent-tasks/${task.id}/cancel`, { method: "POST", cookie: t.alice.cookie,
      body: { expectedRevision: submitted.revision } }), 409);
    gate.release(); await pending; pending = null;
    assert.equal(expect(await t.read(task.id)).task.state, "accepted"); await t.run(); assert.equal(t.messages.length, 1);
  } finally { gate?.release(); await pending?.catch(() => {}); await t.close(); }
});

test("Agent and normal SMTP racing for the last shared recipient slot reserve only one actual submission", async () => {
  const t = await agentTasksFixture();
  try {
    expect(await t.configure()); expect(await t.send(), 201); expect(await t.send(), 201);
    const task = expect(await t.enqueue(), 201).task;
    const [, normal] = await Promise.all([t.run(), t.send()]);
    assert.ok([201, 409].includes(normal.status), normal.text);
    const result = expect(await t.read(task.id)).task;
    assert.equal(result.state, normal.status === 201 ? "queued" : "accepted");
    assert.equal(t.messages.length, 3); assert.equal(t.opens.length, 3);
    assert.equal(await t.h.db.prepare("SELECT SUM(recipient_count) n FROM send_recipient_charges WHERE created_at>=unixepoch()-60").first("n"), 3);
  } finally { await t.close(); }
});
