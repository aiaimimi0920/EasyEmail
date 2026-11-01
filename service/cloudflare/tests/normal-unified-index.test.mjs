import assert from "node:assert/strict";
import { test } from "node:test";
import { normalAccessFixture } from "./normal-access-fixture.mjs";
import { RAW_MESSAGE } from "./normal-read-fixture.mjs";

const query = t => t.h.request("/api/v1/messages?sources=normal", { cookie: t.alice.cookie });
test("new receipt atomically includes search projection, while legacy backfill is bounded, resumable and identity preserving", async () => {
  const messages = new Map(Array.from({ length: 7 }, (_, index) => [index + 1, RAW_MESSAGE]));
  const t = await normalAccessFixture({ messages, uidNext: 8 });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await t.receive()).body.request.state, "committed");
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_search").first("n"), 7);
    const before = (await t.h.db.prepare("SELECT * FROM normal_inbox_messages ORDER BY id").all()).results;
    const state = await t.state(); await t.h.db.prepare("DELETE FROM normal_inbox_search").run();
    const pending = await query(t); assert.equal(pending.status, 409, pending.text); assert.equal(pending.body.error.code, "normal_index_pending");
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_search").first("n"), 5);
    const next = await query(t); assert.equal(next.status, 200, next.text); assert.equal(next.body.items.length, 7);
    assert.deepEqual((await t.h.db.prepare("SELECT * FROM normal_inbox_messages ORDER BY id").all()).results, before);
    assert.deepEqual(await t.state(), state); assert.equal(t.opens.length, 3);
    await t.h.restart(); assert.equal((await query(t)).body.items.length, 7); assert.equal(t.opens.length, 3);
  } finally { await t.close(); }
});

test("late legacy index repair is fenced by the current source and cannot populate or disclose a superseded epoch", async () => {
  const t = await normalAccessFixture(); let pending;
  const gate = t.holdPut("/get");
  try {
    await t.receive(); await t.h.db.prepare("DELETE FROM normal_inbox_search").run();
    pending = query(t); await gate.entered; assert.equal((await t.save({ username: "new-source" }, 1)).status, 200);
    gate.release(); const result = await pending; pending = null;
    assert.equal(result.status, 409, result.text); assert.equal(result.text.includes("742951"), false);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_search").first("n"), 0);
    assert.equal((await query(t)).body.items.length, 0);
  } finally { gate.release(); if (pending) await pending; await t.close(); }
});

test("legacy object corruption fails closed and unrelated temporary selection does not force ordinary repair", async () => {
  const t = await normalAccessFixture();
  try {
    await t.receive(); await t.h.db.prepare("DELETE FROM normal_inbox_search").run();
    const row = await t.h.db.prepare("SELECT * FROM normal_inbox_messages LIMIT 1").first();
    const bucket = await t.h.bucket("INBOX"); await bucket.put(row.content_key, "corrupt");
    assert.equal((await query(t)).status, 503);
    const selected = await t.h.request("/api/v1/messages?sources=all&providerId=missing", { cookie: t.alice.cookie });
    assert.equal(selected.status, 200, selected.text); assert.deepEqual(selected.body.items, []); assert.equal(t.opens.length, 1);
  } finally { await t.close(); }
});

test("failed staging never exposes uncommitted search rows or advances the unified timeline", async () => {
  const t = await normalAccessFixture();
  try {
    t.failPut(); assert.equal((await t.receive()).body.request.state, "failed");
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_batches WHERE status='staged'").first("n"), 1);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_search").first("n"), 0);
    assert.deepEqual((await query(t)).body.items, []); assert.equal((await t.state()).after_uid, 0);
  } finally { await t.close(); }
});

test("ordinary extraction explicitly reports its ten-message cached search budget", async () => {
  const messages = new Map(Array.from({ length: 11 }, (_, index) => [index + 1, RAW_MESSAGE]));
  const t = await normalAccessFixture({ messages, uidNext: 12 });
  try {
    for (let i = 0; i < 4; i++) assert.equal((await t.receive()).body.request.state, "committed");
    const result = await t.h.request(`${t.base}/extractions?since=1&kind=otp`, { cookie: t.alice.cookie });
    assert.equal(result.status, 200, result.text); assert.equal(result.body.items.length, 10);
    assert.equal(result.body.searched, 10); assert.equal(result.body.searchLimit, 10); assert.equal(result.body.searchLimited, true);
    assert.equal(t.opens.length, 4);
  } finally { await t.close(); }
});
