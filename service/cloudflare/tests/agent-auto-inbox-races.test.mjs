import assert from "node:assert/strict";
import { test } from "node:test";
import { expect } from "./agent-services-fixture.mjs";
import { autoInboxFixture } from "./agent-auto-inbox-fixture.mjs";

for (const gatePath of ["/close", "/put"]) for (const change of ["disable", "revision", "owner"]) test(`automatic ${gatePath} late write is fenced after ${change}`, async () => {
  const t = await autoInboxFixture(), gate = t.holdPut(gatePath); let pending;
  try {
    expect(await t.configure()); pending = t.tick(); await gate.entered;
    if (change === "disable") expect(await t.configure({ expectedRevision: 1, enabled: false, persistentAuthorization: false }));
    if (change === "revision") expect(await t.save({ username: "NewAlice" }, 1));
    if (change === "owner") await t.h.db.prepare("UPDATE users SET status='disabled' WHERE id=?").bind(t.alice.id).run();
    gate.release(); await pending; pending = null;
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_incoming_messages").first("n"), 0);
    assert.equal(await t.h.db.prepare("SELECT after_uid FROM agent_inbox_state WHERE account_id=?").bind(t.id).first("after_uid"), 0);
    if (gatePath === "/close") assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_inbox_batches").first("n"), 0);
    if (change !== "owner") { const config = expect(await t.config()).config; assert.equal(config.ready, false); if (change === "disable") assert.equal(config.revision, 2); }
    await t.tick(); assert.equal(t.opens.length, 1);
  } finally { gate.release(); if (pending) await pending; await t.close(); }
});

test("concurrent cron calls and explicit receive share one account claim, and an active manual claim is not preempted by cron", async () => {
  const t = await autoInboxFixture(), gate = t.holdPut(); let pending;
  try {
    expect(await t.configure()); pending = t.tick(); await gate.entered;
    await t.tick(); assert.equal(t.opens.length, 1);
    assert.equal(expect(await t.receive()).operation.state, "failed"); assert.equal(t.opens.length, 1);
    gate.release(); await pending; pending = null;
    await t.due(); const second = t.holdPut("/close");
    try {
      pending = t.receive(); await second.entered; await t.tick(); assert.equal(t.opens.length, 2);
      second.release(); assert.equal(expect(await pending).operation.state, "committed"); pending = null;
    } finally { second.release(); }
    await t.tick(); assert.equal(t.opens.length, 3);
  } finally { gate.release(); if (pending) await pending; await t.close(); }
});
