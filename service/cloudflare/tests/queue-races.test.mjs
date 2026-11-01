import assert from "node:assert/strict";
import { test } from "node:test";
import { queueFixture } from "./queue-fixture.mjs";
import { selectGates } from "./account-race-fixture.mjs";
import { sendCalls } from "./send-fixture.mjs";

const entry = new URL("./queue-fault-worker.ts", import.meta.url);
test("guard commit with lost D1 acknowledgement dispatches zero times and later stays unknown", async () => {
  const t = await queueFixture({ entry, bindings: { TEST_QUEUE_FAULT: "guard-receipt-lost" } });
  try {
    const job = (await t.enqueue()).body.job; await t.tick();
    assert.equal(sendCalls(t.f).length, 0); assert.equal((await t.get(job.id)).body.job.state, "pending");
    await t.h.db.exec("UPDATE outgoing_messages SET created_at=unixepoch()-120");
    await t.h.scheduled(); await t.tick(); await t.h.restart(); await t.tick();
    const detail = (await t.get(job.id)).body.job;
    assert.equal(detail.state, "unknown"); assert.equal(detail.retrySafe, false);
    assert.equal((await t.action(detail, "retry")).status, 409); assert.equal((await t.action(detail, "cancel")).status, 409);
    assert.equal(sendCalls(t.f).length, 0);
  } finally { await t.close(); }
});

for (const mutation of ["cancel", "stale-claim", "disable-account", "disable-mailbox", "provider-revision"]) {
  test(`final reservation fence rejects ${mutation} after preparation snapshot`, async () => {
    const gates = await selectGates(), gate = gates.hold("reservation", "unused");
    const t = await queueFixture({ entry, bindings: { TEST_QUEUE_GATE: `${gates.bindings.TEST_SELECT_GATE}/reservation` } });
    let tick;
    try {
      const job = (await t.enqueue()).body.job; tick = t.tick(); await gate.entered();
      if (mutation === "cancel") {
        const current = (await t.get(job.id)).body.job;
        assert.equal((await t.action(current, "cancel")).body.job.state, "cancelled");
      } else if (mutation === "stale-claim") {
        await t.h.db.prepare("UPDATE send_jobs SET claim_token=?,lease_until=unixepoch()+120 WHERE id=?").bind(crypto.randomUUID(), job.id).run();
      } else if (mutation === "provider-revision") {
        const config = JSON.parse(t.f.bindings.PROVIDER_CONFIG)[0];
        await t.h.db.prepare(`INSERT INTO provider_overrides(id,config_json,revision,secret_source,change_token,updated_at)
          VALUES ('self',?,1,'environment','synthetic-queue-fence',unixepoch())`).bind(JSON.stringify(config)).run();
      } else if (mutation === "disable-account") await t.h.db.prepare("UPDATE users SET status='disabled' WHERE id=?").bind(t.alice.id).run();
      else await t.h.db.prepare("UPDATE mailboxes SET disabled_at=unixepoch() WHERE id=?").bind(t.box.id).run();
      gate.release(); await tick; tick = null;
      assert.equal(sendCalls(t.f).length, 0); assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM outgoing_messages").first("n"), 0);
      if (mutation === "stale-claim") {
        await t.h.restart({ TEST_QUEUE_GATE: "" });
        await t.h.db.prepare("UPDATE send_jobs SET lease_until=unixepoch()-1 WHERE id=?").bind(job.id).run();
        await t.tick(); await t.tick(); assert.equal(sendCalls(t.f).length, 1);
      }
    } finally { gate.release(); if (tick) await tick; await t.close(); await gates.close(); }
  });
}

test("provider accepted but every result write fails: durable guard prevents redispatch", async () => {
  const t = await queueFixture();
  try {
    const job = (await t.enqueue()).body.job;
    await t.h.db.exec("CREATE TRIGGER fail_queue_result BEFORE UPDATE ON outgoing_messages BEGIN SELECT RAISE(ABORT,'synthetic result loss'); END");
    await t.tick();
    assert.equal(sendCalls(t.f).length, 1); assert.equal((await t.get(job.id)).body.job.state, "pending");
    await t.h.db.exec("DROP TRIGGER fail_queue_result");
    await t.h.db.exec("UPDATE outgoing_messages SET created_at=unixepoch()-120");
    await t.h.scheduled(); await t.h.restart(); await t.tick();
    assert.equal((await t.get(job.id)).body.job.state, "unknown"); assert.equal(sendCalls(t.f).length, 1);
  } finally { await t.close(); }
});
