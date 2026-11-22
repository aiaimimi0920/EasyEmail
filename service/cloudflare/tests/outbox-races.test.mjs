import assert from "node:assert/strict";
import { test } from "node:test";
import { assetBytes, assetMetadata, assetRef, outboxFixture, putAsset } from "./outbox-fixture.mjs";
import { sendBody, sendCalls, sendRequest } from "./send-fixture.mjs";
import { selectGates } from "./account-race-fixture.mjs";

const entry = new URL("./outbox-fault-worker.ts", import.meta.url);
const remove = (t, id) => t.h.request(`/api/v1/outbox-attachments/${id}`, { method: "DELETE", cookie: t.alice.cookie, body: {} });
test("one atomic quota reservation wins at capacity and minute limits; same-key concurrency charges only one resource", async () => {
  const t = await outboxFixture();
  try {
    const meta = { ...assetMetadata(), size: 2 * 1024 * 1024 }, key = crypto.randomUUID();
    const same = await Promise.all([1, 2].map(() => t.reserve(meta, key)));
    assert.deepEqual(same.map(r => r.status).sort(), [200, 201]); assert.equal(same[0].body.attachment.id, same[1].body.attachment.id);
    for (let i = 0; i < 6; i++) assert.equal((await t.reserve(meta)).status, 201);
    const last = await Promise.all([1, 2].map(() => t.reserve(meta)));
    assert.deepEqual(last.map(r => r.status).sort(), [201, 429]);
    assert.equal(await t.h.db.prepare("SELECT SUM(size) n FROM outbox_assets WHERE cleanup_at IS NULL").first("n"), 16 * 1024 * 1024);
    // Terminating a row without confirmed object cleanup must not refund capacity.
    await t.h.db.exec("UPDATE outbox_assets SET state='deleted'"); assert.equal((await t.reserve(meta)).status, 429);
    await t.h.db.exec("UPDATE outbox_assets SET cleanup_at=unixepoch()");
    assert.equal((await t.reserve()).status, 201); assert.equal((await t.reserve()).status, 201);
    assert.equal((await t.reserve()).status, 429);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM outbox_assets").first("n"), 10);
  } finally { await t.close(); }
});

test("late put after confirmed deletion cannot revive the row and is compensated without overwriting a fresh asset", async () => {
  const gates = await selectGates(); let t, gate, pending;
  try {
    t = await outboxFixture({ entry, bindings: gates.bindings }); const id = (await t.reserve()).body.attachment.id;
    gate = gates.hold("late-put", "outbox");
    pending = putAsset(t.h, t.alice, id, assetBytes, { headers: { ...gate.headers, "x-test-r2-gate": "put" } });
    await gate.entered(); assert.equal((await remove(t, id)).status, 200);
    gate.release(); const result = await pending; pending = null;
    assert.equal(result.status, 409); assert.equal((await (await t.h.bucket()).list()).objects.length, 0);
    assert.equal((await t.h.request(`/api/v1/outbox-attachments/${id}`, { cookie: t.alice.cookie })).body.attachment.state, "deleted");
    const fresh = await t.upload(); assert.notEqual(fresh.id, id);
    assert.equal((await t.h.request(`/api/v1/outbox-attachments/${id}/check`, { method: "POST", cookie: t.alice.cookie, body: {} })).status, 409);
    assert.equal((await (await t.h.bucket()).list()).objects.length, 1);
  } finally { gate?.release(); await pending?.catch(() => {}); await t?.close(); await gates.close(); }
});

test("send reservation pins ready assets; deletion before final reservation fences even already-read bytes", async () => {
  const gates = await selectGates(); let t, gate, pending;
  try {
    t = await outboxFixture({ entry, bindings: gates.bindings }); const asset = await t.upload(), body = { ...sendBody, attachments: [assetRef(asset)] };
    gate = gates.hold("before-reserve", "outbox");
    pending = sendRequest(t.h, t.alice.cookie, t.box, crypto.randomUUID(), body,
      { headers: { ...gate.headers, "x-test-d1-gate": "reservation", "idempotency-key": crypto.randomUUID() } });
    await gate.entered(); assert.equal((await remove(t, asset.id)).status, 200); gate.release();
    assert.equal((await pending).status, 409); pending = null; assert.equal(sendCalls(t.f).length, 0);
    const next = await t.upload(); gate = t.f.hold("/cf/admin/send_mail_by_binding");
    pending = sendRequest(t.h, t.alice.cookie, t.box, crypto.randomUUID(), { ...sendBody, attachments: [assetRef(next)] });
    await gate.entered; assert.equal((await remove(t, next.id)).body.error.code, "outbox_attachment_in_use");
    gate.release(); assert.equal((await pending).status, 201); pending = null;
    assert.equal((await remove(t, next.id)).status, 200); assert.equal(sendCalls(t.f).length, 1);
  } finally { gate?.release(); await pending?.catch(() => {}); await t?.close(); await gates.close(); }
});

test("bounded inventory pagination removes late terminal objects but retains active and unrelated objects", async () => {
  const t = await outboxFixture();
  try {
    const ready = await t.upload(), source = await t.h.db.prepare("SELECT * FROM outbox_assets WHERE id=?").bind(ready.id).first();
    const bucket = await t.h.bucket(), insert = async row => t.h.db.prepare(`INSERT INTO outbox_assets(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(() => "?").join(",")})`).bind(...Object.values(row)).run();
    for (let i = 0; i < 23; i++) {
      const id = crypto.randomUUID(), key = `outbox/v1/${t.alice.id}/${id}`;
      await insert({ ...source, id, object_key: key, request_key: id, state: "deleted", cleanup_at: Math.floor(Date.now() / 1000) });
      await bucket.put(key, assetBytes);
    }
    const unrelated = "outbox/v1/not-a-user/do-not-delete", freshUnknown = `outbox/v1/${t.alice.id}/${crypto.randomUUID()}`;
    await bucket.put(unrelated, assetBytes); await bucket.put(freshUnknown, assetBytes);
    await t.h.scheduled(); assert.ok(await t.h.db.prepare("SELECT cursor FROM outbox_cleanup_state").first("cursor"));
    await t.h.scheduled();
    const remaining = (await (await t.h.bucket()).list()).objects.map(row => row.key).sort();
    assert.deepEqual(remaining, [source.object_key, unrelated, freshUnknown].sort());
    assert.equal((await t.h.request(`/api/v1/outbox-attachments/${ready.id}`, { cookie: t.alice.cookie })).body.attachment.state, "ready");
  } finally { await t.close(); }
});
