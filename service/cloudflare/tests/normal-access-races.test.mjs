import assert from "node:assert/strict";
import { test } from "node:test";
import { normalAccessFixture } from "./normal-access-fixture.mjs";
import { multipartMessage } from "./normal-mime-fixture.mjs";

test("one public request owns one network read; concurrent replay and restart only reconcile its immutable receipt", async () => {
  const t = await normalAccessFixture(), gate = t.holdPut(), key = crypto.randomUUID(); let pending;
  try {
    pending = t.receive(key); await gate.entered;
    const replay = await t.receive(key); assert.equal(replay.status, 200, replay.text); assert.equal(replay.body.request.state, "pending");
    await t.h.db.prepare("UPDATE normal_inbox_requests SET created_at=unixepoch()-100 WHERE id=?").bind(replay.body.request.id).run();
    assert.equal((await t.receipt(key)).body.request.state, "pending", "actual live claim, not reservation age, determines pending state");
    assert.equal(t.opens.length, 1);
    gate.release(); const result = await pending; pending = null;
    assert.equal(result.body.request.state, "committed", result.text); assert.equal(result.body.request.id, replay.body.request.id);
    assert.equal((await t.receipt(key)).body.request.state, "committed"); assert.equal(t.opens.length, 1);
  } finally { gate.release(); if (pending) await pending; await t.close(); }
});

test("failed staged writes are terminal for their original public key and never silently reconnect on replay", async () => {
  const t = await normalAccessFixture(), key = crypto.randomUUID();
  try {
    t.failPut(); const failed = await t.receive(key); assert.equal(failed.status, 200, failed.text);
    assert.equal(failed.body.request.state, "failed"); assert.equal(failed.body.request.errorCode, "normal_inbox_storage_failed");
    assert.equal((await t.state()).after_uid, 0); assert.equal(failed.body.request.result, null);
    t.failPut(false); assert.deepEqual((await t.receive(key)).body, failed.body); assert.equal(t.opens.length, 1);
    assert.equal((await t.receive()).body.request.state, "committed"); assert.equal(t.opens.length, 2);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_batches WHERE status='staged'").first("n"), 1);
  } finally { await t.close(); }
});

for (const kind of ["detail", "raw", "attachment"]) test(`late ${kind} cannot return bytes from a superseded source`, async () => {
  const t = await normalAccessFixture(kind === "attachment" ? { messages: new Map([[1, multipartMessage()]]), uidNext: 2 } : {}), gate = t.holdPut("/get"); let pending;
  try {
    assert.equal((await t.receive()).body.request.state, "committed"); const id = (await t.messages()).body.items[0].id;
    pending = kind === "detail" ? t.message(id) : t.binary(id, kind === "raw" ? "raw" : "attachments/0");
      await gate.entered; assert.equal((await t.save({ username: "new-source" }, 1)).status, 200);
      gate.release(); const result = await pending; pending = null;
      assert.equal(kind === "detail" ? result.status : result.response.status, 409);
      assert.equal(kind === "detail" ? result.text.includes("742951") : result.bytes.includes(Buffer.from("742951")), false);
  } finally { gate.release(); if (pending) await pending; await t.close(); }
});

test("content and raw corruption fail closed, while valid pre-summary rows remain readable without identity rewrites", async () => {
  const t = await normalAccessFixture();
  try {
    assert.equal((await t.receive()).body.request.state, "committed"); const id = (await t.messages()).body.items[0].id;
    const row = await t.h.db.prepare("SELECT * FROM normal_inbox_messages WHERE id=?").bind(id).first();
    await t.h.db.prepare("UPDATE normal_inbox_messages SET summary=NULL WHERE id=?").bind(id).run();
    assert.equal((await t.messages()).status, 200); assert.equal((await t.message(id)).status, 200);
    assert.equal((await t.h.db.prepare("SELECT id,raw_sha256,summary FROM normal_inbox_messages WHERE id=?").bind(id).first()).summary, null);
    const bucket = await t.h.bucket("INBOX"), bytes = new Uint8Array(await (await bucket.get(row.content_key)).arrayBuffer()); bytes[0] ^= 1;
    await bucket.put(row.content_key, bytes);
    assert.equal((await t.message(id)).body.error.code, "normal_content_unavailable");
    assert.equal((await t.messages()).body.error.code, "normal_content_unavailable");
    const raw = new Uint8Array(await (await bucket.get(row.raw_key)).arrayBuffer()); raw[0] ^= 1; await bucket.put(row.raw_key, raw);
    const download = await t.binary(id, "raw"); assert.equal(download.response.status, 503); assert.equal(download.bytes.includes(Buffer.from("742951")), false);
  } finally { await t.close(); }
});

test("historical failed requests do not exhaust receive capacity and their original keys never reconnect", async () => {
  const t = await normalAccessFixture(), key = crypto.randomUUID();
  try {
    assert.equal((await t.receive(key)).body.request.state, "committed"); const opens = t.opens.length;
    await t.h.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1005)
      INSERT INTO normal_inbox_requests(id,account_id,request_key,account_revision,created_at,finished_at,error_code)
      SELECT 'seed-'||i,?,'seed-request-key-'||i,1,unixepoch()-1000,unixepoch()-999,'normal_sync_interrupted' FROM n`).bind(t.id).run();
    const failed = await t.receive("seed-request-key-1005"); assert.equal(failed.body.request.state, "failed");
    assert.equal(t.opens.length, opens);
    const result = await t.receive(); assert.equal(result.status, 200, result.text); assert.equal(result.body.request.state, "committed");
    assert.equal(t.opens.length, opens + 1); assert.equal((await t.receive(key)).body.request.state, "committed");
    assert.deepEqual((await t.receive("seed-request-key-1005")).body, failed.body);
    assert.equal(t.opens.length, opens + 1); assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_requests").first("n"), 1007);
  } finally { await t.close(); }
});
