import assert from "node:assert/strict";
import { test } from "node:test";
import { expect } from "./agent-services-fixture.mjs";
import { autoInboxFixture } from "./agent-auto-inbox-fixture.mjs";

for (const fault of ["automatic-reservation-ack", "automatic-claim-ack"]) test(`automatic ${fault} never connects and the original run is not replayed`, async () => {
  const t = await autoInboxFixture({ bindings: { TEST_AGENT_INBOX_FAULT: fault } });
  try {
    expect(await t.configure()); await t.tick(); assert.equal(t.opens.length, 0);
    const first = expect(await t.config()).config, rows = (await t.h.db.prepare("SELECT * FROM agent_inbox_requests ORDER BY id").all()).results;
    assert.equal(rows.length, 1);
    await t.h.restart({ TEST_AGENT_INBOX_FAULT: "" }); await t.tick(); assert.equal(t.opens.length, 0);
    if (fault === "automatic-reservation-ack") {
      await t.h.db.prepare("UPDATE agent_inbox_automation SET lease_until=unixepoch()-1 WHERE account_id=?").bind(t.id).run();
      await t.tick(); assert.equal(expect(await t.config()).config.lastState, "interrupted");
    }
    assert.equal(expect(await t.receipt(first.lastRequestKey)).operation.state, "failed"); assert.equal(t.opens.length, 0);
    await t.h.db.prepare("UPDATE agent_inbox_state SET claim_lease_until=unixepoch()-1 WHERE account_id=?").bind(t.id).run();
    await t.due(); await t.tick(); assert.equal(t.opens.length, 1);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_inbox_requests").first("n"), 2);
  } finally { await t.close(); }
});

test("automatic config and receive commit ACK loss reconcile durable originals; an unrecorded runner finish reconciles a committed request without reconnecting", async () => {
  const t = await autoInboxFixture({ bindings: { TEST_AGENT_INBOX_FAULT: "automatic-config-ack" } });
  try {
    const key = crypto.randomUUID(), original = expect(await t.configure({}, key)).operation;
    assert.deepEqual(expect(await t.configure({}, key)).operation, original); assert.equal(t.opens.length, 0);
    await t.h.restart({ TEST_AGENT_INBOX_FAULT: "commit-ack" }); await t.tick();
    assert.equal(expect(await t.config()).config.lastState, "committed"); assert.equal(t.opens.length, 1);
    await t.h.restart({ TEST_AGENT_INBOX_FAULT: "automatic-finish-before" }); await t.due(); await t.tick();
    const running = expect(await t.config()).config; assert.equal(running.lastState, "running"); assert.equal(t.opens.length, 2);
    assert.equal(expect(await t.receipt(running.lastRequestKey)).operation.state, "committed");
    await t.h.restart({ TEST_AGENT_INBOX_FAULT: "" });
    await t.h.db.prepare("UPDATE agent_inbox_automation SET lease_until=unixepoch()-1 WHERE account_id=?").bind(t.id).run();
    await t.tick(); assert.equal(expect(await t.config()).config.lastState, "committed"); assert.equal(t.opens.length, 2);
  } finally { await t.close(); }
});
