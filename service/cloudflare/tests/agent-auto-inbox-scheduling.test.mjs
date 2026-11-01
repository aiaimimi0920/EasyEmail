import assert from "node:assert/strict";
import { test } from "node:test";
import { expect } from "./agent-services-fixture.mjs";
import { autoInboxFixture } from "./agent-auto-inbox-fixture.mjs";
import { exhaustAgentAdmission, seedAgentEmptyHistory, seedAgentRequestHistory } from "./agent-capacity-fixture.mjs";

test("cron admits at most three due accounts and advances their due times so other authorized accounts are not starved", async () => {
  const t = await autoInboxFixture();
  try {
    const ids = [t.id]; expect(await t.configure());
    for (let i = 0; i < 4; i++) {
      const id = crypto.randomUUID(); expect(await t.save({ emailAddress: `alice${i}@example.test` }, 0, t.alice.cookie, id), 201); ids.push(id);
      expect(await t.h.request(`/api/v1/agent-accounts/${id}/auto-inbox`, { method: "PUT", cookie: t.alice.cookie,
        headers: { "idempotency-key": crypto.randomUUID() }, body: { expectedAccountRevision: 1, expectedRevision: 0, enabled: true, intervalMinutes: 5, persistentAuthorization: true } }));
    }
    for (const [i, id] of ids.entries()) await t.h.db.prepare("UPDATE agent_inbox_automation SET next_due_at=unixepoch()-3600+? WHERE account_id=?").bind(i, id).run();
    await t.tick(); assert.equal(t.opens.length, 3);
    const first = (await t.h.db.prepare("SELECT account_id FROM agent_inbox_automation WHERE last_state='committed'").all()).results.map(row => row.account_id);
    assert.deepEqual(first.sort(), ids.slice(0, 3).sort());
    await t.tick(); assert.equal(t.opens.length, 5);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_inbox_automation WHERE last_state='committed'").first("n"), 5);
    await t.tick(); assert.equal(t.opens.length, 5);
  } finally { await t.close(); }
});

test("automatic transport failures back off, success resets failure state, and manual/automatic admission budgets are shared", async () => {
  const t = await autoInboxFixture();
  try {
    expect(await t.configure({ intervalMinutes: 5 })); await seedAgentRequestHistory(t);
    await exhaustAgentAdmission(t); await t.tick(); assert.equal(t.opens.length, 0);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_inbox_requests").first("n"), 10005);
    await t.h.resetLimits(); await t.due(); t.failPut(); await t.tick(); assert.equal(t.opens.length, 1);
    let row = await t.h.db.prepare("SELECT * FROM agent_inbox_automation WHERE account_id=?").bind(t.id).first();
    assert.equal(row.failures, 1); assert.equal(row.last_state, "failed"); assert.ok(row.next_due_at - row.last_finished_at >= 600);
    await t.tick(); assert.equal(t.opens.length, 1);
    await t.due(); await t.tick(); row = await t.h.db.prepare("SELECT * FROM agent_inbox_automation WHERE account_id=?").bind(t.id).first();
    assert.equal(row.failures, 2); assert.ok(row.next_due_at - row.last_finished_at >= 1200); assert.equal(t.opens.length, 2);
    t.failPut(false); await t.due(); await t.tick(); row = await t.h.db.prepare("SELECT * FROM agent_inbox_automation WHERE account_id=?").bind(t.id).first();
    assert.equal(row.failures, 0); assert.equal(row.last_state, "committed"); assert.equal(row.revision, 1); assert.equal(t.opens.length, 3);
  } finally { await t.close(); }
});

test("a rate-limited owner's earliest accounts yield bounded cron slots to another owner without creating requests", async () => {
  const t = await autoInboxFixture();
  try {
    expect(await t.configure()); const ids = [t.id];
    for (let i = 0; i < 2; i++) {
      const id = crypto.randomUUID(); expect(await t.save({ emailAddress: `limited${i}@example.test` }, 0, t.alice.cookie, id), 201); ids.push(id);
      expect(await t.h.request(`/api/v1/agent-accounts/${id}/auto-inbox`, { method: "PUT", cookie: t.alice.cookie,
        headers: { "idempotency-key": crypto.randomUUID() }, body: { expectedAccountRevision: 1, expectedRevision: 0, enabled: true, intervalMinutes: 5, persistentAuthorization: true } }));
    }
    const bob = await t.h.register("automatic-fair-bob"), bobId = crypto.randomUUID();
    expect(await t.save({ emailAddress: "bob@example.test" }, 0, bob.cookie, bobId), 201);
    expect(await t.h.request(`/api/v1/agent-accounts/${bobId}/auto-inbox`, { method: "PUT", cookie: bob.cookie,
      headers: { "idempotency-key": crypto.randomUUID() }, body: { expectedAccountRevision: 1, expectedRevision: 0, enabled: true, intervalMinutes: 5, persistentAuthorization: true } }));
    for (const [i, id] of [...ids, bobId].entries()) await t.h.db.prepare("UPDATE agent_inbox_automation SET next_due_at=unixepoch()-3600+? WHERE account_id=?").bind(i, id).run();
    const before = (await t.h.db.prepare("SELECT * FROM agent_inbox_automation WHERE user_id=? ORDER BY account_id").bind(t.alice.id).all()).results;
    await exhaustAgentAdmission(t); await t.tick(); assert.equal(t.opens.length, 0);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_inbox_requests").first("n"), 0);
    const after = (await t.h.db.prepare("SELECT * FROM agent_inbox_automation WHERE user_id=? ORDER BY account_id").bind(t.alice.id).all()).results;
    assert.deepEqual(after.map(({ next_due_at, ...row }) => row), before.map(({ next_due_at, ...row }) => row));
    for (const row of after) assert.ok(row.next_due_at >= Math.floor(Date.now() / 1000) + 58);
    await t.tick(); assert.equal(t.opens.length, 1);
    assert.equal(await t.h.db.prepare("SELECT last_state FROM agent_inbox_automation WHERE account_id=?").bind(bobId).first("last_state"), "committed");
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_inbox_requests WHERE user_id=?").bind(t.alice.id).first("n"), 0);
  } finally { await t.close(); }
});

test("automatic receive at live batch capacity creates no request and opens no socket", async () => {
  const t = await autoInboxFixture();
  try {
    const original = expect(await t.receive()).operation; await seedAgentEmptyHistory(t, original, 1000, "staged");
    expect(await t.configure()); const before = await t.h.db.prepare("SELECT COUNT(*) n FROM agent_inbox_requests").first("n");
    await t.tick(); assert.equal(t.opens.length, 1);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_inbox_requests").first("n"), before);
    const row = await t.h.db.prepare("SELECT * FROM agent_inbox_automation WHERE account_id=?").bind(t.id).first();
    assert.equal(row.run_token, null); assert.equal(row.last_error_code, "agent_inbox_changed_or_limit");
  } finally { await t.close(); }
});
