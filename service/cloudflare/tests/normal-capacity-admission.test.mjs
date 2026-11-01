import assert from "node:assert/strict";
import { test } from "node:test";
import { normalAccessFixture } from "./normal-access-fixture.mjs";
import { exhaustAdmission, syncRows, syncBudgetRows } from "./normal-capacity-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";

test("concurrent new-key configuration failures have bounded admission before any permanent metadata or socket", async () => {
  const t = await normalAccessFixture({ noBucket: true });
  try {
    const minute = Math.floor(Date.now() / 60000), keys = Array.from({ length: 32 }, () => crypto.randomUUID());
    const responses = await Promise.all(keys.map(key => t.receive(key)));
    const windows = Math.floor(Date.now() / 60000) - minute + 1;
    assert.ok(windows <= 2, "fixture should not run across more than two admission buckets");
    const accepted = responses.filter(r => r.status === 200), rejected = responses.filter(r => r.status === 429);
    assert.ok(accepted.length > 0 && accepted.length <= windows * 10);
    assert.equal(accepted.length + rejected.length, 32); assert.ok(rejected.length > 0);
    for (const r of accepted) { assert.equal(r.body.request.state, "failed"); assert.equal(r.body.request.errorCode, "normal_inbox_not_configured"); }
    for (const r of rejected) assert.equal(r.body.error.code, "rate_limited");
    assert.equal((await syncRows(t.h)).length, accepted.length); assert.equal(t.opens.length, 0);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_batches").first("n"), 0);
    const i = responses.findIndex(r => r.status === 200), before = await syncRows(t.h);
    assert.deepEqual((await t.receive(keys[i])).body, responses[i].body);
    assert.equal((await t.receive(keys[i], 2)).body.error.code, "idempotency_conflict");
    assert.deepEqual(await syncRows(t.h), before);
    await t.h.resetLimits();
    const retry = await t.receive(keys[responses.findIndex(r => r.status === 429)]);
    assert.equal(retry.status, 200, retry.text); assert.equal((await syncRows(t.h)).length, before.length + 1);
  } finally { await t.close(); }
});

for (const kind of ["user", "platform"]) test(`${kind} admission denial creates no durable request and old committed keys still replay`, async () => {
  const t = await normalAccessFixture(), key = crypto.randomUUID();
  try {
    const original = await t.receive(key); assert.equal(original.body.request.state, "committed");
    const before = await syncRows(t.h), state = await t.state();
    await exhaustAdmission(t.h, kind === "user" ? "normal-inbox-request" : "normal-inbox-request-global", kind === "user" ? t.alice.id : "platform", kind === "user" ? 10 : 60);
    const blocked = await t.receive(); assert.equal(blocked.status, 429, blocked.text);
    assert.deepEqual(await syncRows(t.h), before); assert.deepEqual(await t.state(), state); assert.equal(t.opens.length, 1);
    const counters = await syncBudgetRows(t);
    assert.deepEqual((await t.receive(key)).body, original.body);
    assert.deepEqual(await syncBudgetRows(t), counters, "replay bypasses new-key and transport budgets, not the existing general API limiter");
    const denied = await newKey(t.h, t.alice.cookie, { scopes: ["mail-accounts:read"] });
    assert.equal((await t.receive(crypto.randomUUID(), 1, { token: denied.token, cookie: undefined, origin: null })).status, 403);
    assert.deepEqual(await syncRows(t.h), before); assert.equal(t.opens.length, 1);
  } finally { await t.close(); }
});

test("pending original keys reconcile without admission or a second network read even when the new-key budget is exhausted", async () => {
  const t = await normalAccessFixture(), gate = t.holdPut(), key = crypto.randomUUID(); let pending;
  try {
    pending = t.receive(key); await gate.entered;
    await exhaustAdmission(t.h, "normal-inbox-request", t.alice.id, 10);
    const replays = await Promise.all(Array.from({ length: 12 }, () => t.receive(key)));
    for (const r of replays) { assert.equal(r.status, 200, r.text); assert.equal(r.body.request.state, "pending"); }
    assert.equal(new Set(replays.map(r => r.body.request.id)).size, 1);
    assert.equal((await syncRows(t.h)).length, 1); assert.equal(t.opens.length, 1);
    gate.release(); const original = await pending; pending = null;
    assert.equal(original.body.request.state, "committed");
    await t.h.restart(); assert.deepEqual((await t.receive(key)).body, original.body); assert.equal(t.opens.length, 1);
  } finally { gate.release(); if (pending) await pending; await t.close(); }
});
