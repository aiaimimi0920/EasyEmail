import assert from "node:assert/strict";
import { test } from "node:test";
import { expect } from "./agent-services-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";
import { autoInboxFixture } from "./agent-auto-inbox-fixture.mjs";

test("automatic receiving requires its own explicit scope, strict persistent confirmation, owner and Origin", async () => {
  const t = await autoInboxFixture();
  try {
    const bob = await t.h.register("automatic-policy-bob");
    expect(await t.configure({}, undefined, { cookie: bob.cookie }), 404);
    expect(await t.configure({}, undefined, { origin: null }), 403);
    for (const scopes of [["agent-accounts:read", "agent-accounts:sync", "agent-inbox:read"], ["agent-inbox:automate"]]) {
      const key = await newKey(t.h, t.alice.cookie, { scopes }); expect(await t.configure({}, undefined, { token: key.token, origin: null }), 403);
    }
    for (const body of [{ intervalMinutes: 1 }, { intervalMinutes: "15" }, { expectedRevision: -1 }, { expectedAccountRevision: "1" },
      { persistentAuthorization: false }, { from: "other@example.test" }, { enabled: false, persistentAuthorization: true }]) expect(await t.configure(body), 400);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_inbox_automation_operations").first("n"), 0);
    const key = await newKey(t.h, t.alice.cookie, { scopes: ["agent-accounts:read", "agent-inbox:automate"] });
    expect(await t.configure({}, undefined, { token: key.token, origin: null }));
    expect(await t.messages("", { token: key.token }), 403);
    await t.h.request(`/api/v1/api-keys/${key.id}`, { method: "DELETE", cookie: t.alice.cookie });
    await t.tick(); assert.equal(t.opens.length, 1, "a saved owner authorization is not an impersonated or retained API Key");
    expect(await t.configure({ expectedRevision: 1, enabled: false, persistentAuthorization: false }));
    await t.due(); await t.tick(); assert.equal(t.opens.length, 1);
  } finally { await t.close(); }
});

test("endpoint removal or drift stops automatic scheduling until explicit rebind, including restoration of the old endpoint", async () => {
  const t = await autoInboxFixture();
  try {
    expect(await t.configure());
    for (const endpoints of [[], [{ id: "example", label: "测试", hostname: "changed.example.test", port: 993 }]]) {
      await t.h.restart({ IMAP_ENDPOINTS: JSON.stringify(endpoints) }); await t.due(); await t.tick();
      const stopped = await t.h.db.prepare("SELECT * FROM agent_inbox_automation WHERE account_id=?").bind(t.id).first();
      assert.equal(stopped.next_due_at, null); assert.equal(stopped.last_error_code, "agent_inbox_changed");
      assert.equal(t.opens.length, 0); assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_inbox_requests").first("n"), 0);
    }
    await t.h.restart({ IMAP_ENDPOINTS: JSON.stringify([{ id: "example", label: "测试", hostname: "imap.example.test", port: 993 }]) });
    assert.equal(expect(await t.config()).config.ready, false); await t.tick(); assert.equal(t.opens.length, 0);
    expect(await t.configure({ expectedRevision: 1 })); await t.tick(); assert.equal(t.opens.length, 1);
    assert.equal(expect(await t.config()).config.lastState, "committed");
  } finally { await t.close(); }
});

test("the configuration history cap cannot prevent disabling a persistent authorization", async () => {
  const t = await autoInboxFixture();
  try {
    expect(await t.configure());
    await t.h.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10000)
      INSERT INTO agent_inbox_automation_operations(id,user_id,account_id,request_key,request_hash,account_revision,expected_revision,revision,enabled,interval_minutes,completed_at)
      SELECT 'synthetic-cap-'||i,?,?,'synthetic-key-'||i,'synthetic-hash',1,0,1,1,15,1 FROM n`).bind(t.alice.id, t.id).run();
    expect(await t.configure({ expectedRevision: 1 }), 409);
    expect(await t.configure({ expectedRevision: 1, enabled: false, persistentAuthorization: false }));
    assert.equal(expect(await t.config()).config.enabled, false); await t.tick(); assert.equal(t.opens.length, 0);
  } finally { await t.close(); }
});

test("automatic configuration has immutable owner-wide original keys, CAS and exact replay, including concurrent same-key calls", async () => {
  const t = await autoInboxFixture(), key = crypto.randomUUID();
  try {
    const replies = await Promise.all(Array.from({ length: 5 }, () => t.configure({}, key)));
    const original = expect(replies[0]).operation;
    for (const reply of replies) assert.deepEqual(expect(reply).operation, original);
    expect(await t.configure({ intervalMinutes: 5 }, key), 409);
    expect(await t.configure(), 409);
    assert.equal(expect(await t.config()).config.revision, 1);
    await t.h.restart(); assert.deepEqual(expect(await t.configReceipt(key)).operation, original);
    expect(await t.configure({ expectedRevision: 1, enabled: false, persistentAuthorization: false }));
    assert.deepEqual(expect(await t.configure({}, key)).operation, original);
    assert.equal(expect(await t.config()).config.enabled, false); assert.equal(t.opens.length, 0);
    const bob = await t.h.register("automatic-receipt-bob"); expect(await t.configReceipt(key, { cookie: bob.cookie }), 404);
  } finally { await t.close(); }
});

test("an ordinary account connectivity test does not invalidate persistent receive authorization, but a configuration edit requires explicit rebind", async () => {
  const t = await autoInboxFixture();
  try {
    expect(await t.configure());
    expect(await t.h.request(`${t.base}/test`, { method: "POST", cookie: t.alice.cookie, body: { expectedRevision: 1 } }));
    assert.equal(expect(await t.config()).config.ready, true);
    expect(await t.save({ displayName: "renamed" }, 1));
    const stale = expect(await t.config()).config; assert.equal(stale.enabled, true); assert.equal(stale.ready, false); assert.equal(stale.nextDueAt, null);
    await t.tick(); assert.equal(t.opens.length, 1, "only the explicit connectivity test has connected");
    expect(await t.configure({ expectedAccountRevision: 2, expectedRevision: 1 })); await t.tick(); assert.equal(t.opens.length, 2);
  } finally { await t.close(); }
});
