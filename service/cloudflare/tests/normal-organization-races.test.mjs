import assert from "node:assert/strict";
import { test } from "node:test";
import { normalAccessFixture } from "./normal-access-fixture.mjs";

async function fixture() { const t = await normalAccessFixture({ testEntry: "./normal-organization-test-worker.ts" }); await t.receive(); return t; }
const organize = (t, ids, key, mode = "", patch = { isRead: true }) => t.h.request(`${t.base}/messages/organize`, {
  method: "POST", cookie: t.alice.cookie, headers: { "idempotency-key": key, "x-test-normal-organization": mode }, body: { messageIds: ids, ...patch },
});

for (const change of ["revision", "epoch", "inactive"]) test(`late normal organization is fenced atomically by ${change}`, async () => {
  const t = await fixture(), ids = (await t.messages()).body.items.map(row => row.id), gate = t.holdPut(); let pending;
  try {
    pending = organize(t, ids, crypto.randomUUID(), "gate"); await gate.entered;
    if (change === "revision") assert.equal((await t.save({ displayName: "new revision" }, 1)).status, 200);
    if (change === "epoch") { t.scenario({ validity: "43" }); assert.equal((await t.receive()).body.request.state, "committed"); }
    if (change === "inactive") await t.h.db.prepare("UPDATE users SET status='disabled' WHERE id=?").bind(t.alice.id).run();
    gate.release(); const result = await pending; pending = null;
    assert.equal(result.status, 409, result.text);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_message_state").first("n"), 0);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_organization_operations").first("n"), 0);
  } finally { gate.release(); if (pending) await pending; await t.close(); }
});

test("normal batch rollback and lost response preserve original-key reconciliation and concurrent replay", async () => {
  const t = await fixture();
  try {
    const ids = (await t.messages()).body.items.map(row => row.id), key = crypto.randomUUID();
    assert.equal((await organize(t, ids, key, "rollback")).status, 503);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_message_state").first("n"), 0);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_organization_operations").first("n"), 0);
    const recovered = await organize(t, ids, key, "lost"); assert.equal(recovered.status, 200, recovered.text);
    assert.equal(recovered.body.replayed, true);
    const original = await t.h.request(`${t.base}/organization-operations/${key}`, { cookie: t.alice.cookie });
    assert.equal(original.status, 200, original.text); assert.equal(original.body.operation.messageCount, 2);
    const raced = await Promise.all([organize(t, ids, key), organize(t, ids, key)]);
    assert.ok(raced.every(row => row.status === 200 && row.body.replayed));
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_organization_operations").first("n"), 1);
    assert.equal(t.opens.length, 1);
  } finally { await t.close(); }
});

test("normal organization receipt quota stops new writes without blocking immutable replay", async () => {
  const t = await fixture();
  try {
    const ids = (await t.messages()).body.items.map(row => row.id), key = crypto.randomUUID();
    assert.equal((await organize(t, ids, key)).status, 200);
    await t.h.db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<9999)
      INSERT INTO normal_organization_operations(account_id,request_key,id,request_hash,account_revision,epoch_id,required_scopes,message_count,created_at,completed_at)
      SELECT o.account_id,o.request_key||'-'||n.x,o.id||'-'||n.x,o.request_hash,o.account_revision,o.epoch_id,o.required_scopes,o.message_count,o.created_at,o.completed_at
      FROM normal_organization_operations o CROSS JOIN n WHERE o.account_id=? AND o.request_key=?`).bind(t.id, key).run();
    assert.equal((await organize(t, ids, crypto.randomUUID(), "", { isRead: false })).status, 409);
    assert.equal((await organize(t, ids, key)).body.replayed, true);
    assert.ok((await t.messages()).body.items.every(row => row.platformState.isRead));
    assert.equal(t.opens.length, 1);
  } finally { await t.close(); }
});
