import assert from "node:assert/strict";
import { test } from "node:test";
import { assetBytes, assetMetadata, outboxFixture, putAsset } from "./outbox-fixture.mjs";

const entry = new URL("./outbox-fault-worker.ts", import.meta.url);
const route = id => `/api/v1/outbox-attachments/${id}`;
const trigger = (h, name, condition) => h.db.exec(`CREATE TRIGGER ${name} BEFORE UPDATE ON outbox_assets WHEN ${condition} BEGIN SELECT RAISE(ABORT,'synthetic D1 failure'); END`);
test("D1 reservation failure writes no R2 object; failed put preserves the original reservation for recovery", async () => {
  const t = await outboxFixture({ entry });
  try {
    await t.h.db.exec("CREATE TRIGGER fail_reserve BEFORE INSERT ON outbox_assets BEGIN SELECT RAISE(ABORT,'synthetic reserve failure'); END");
    try { assert.equal((await t.reserve()).status, 503); } finally { await t.h.db.exec("DROP TRIGGER fail_reserve"); }
    assert.equal((await (await t.h.bucket()).list()).objects.length, 0);
    const key = crypto.randomUUID(), created = await t.reserve(assetMetadata(), key), id = created.body.attachment.id;
    const failed = await putAsset(t.h, t.alice, id, assetBytes, { headers: { "x-test-r2-fault": "put" } });
    assert.equal(failed.status, 503); assert.equal(failed.body.error.code, "outbox_upload_unconfirmed");
    assert.equal((await t.reserve(assetMetadata(), key)).body.attachment.id, id);
    assert.equal((await t.h.request(route(id), { cookie: t.alice.cookie })).body.attachment.state, "reserved");
    assert.equal((await putAsset(t.h, t.alice, id)).status, 200);
    assert.equal((await (await t.h.bucket()).list()).objects.length, 1);
  } finally { await t.close(); }
});

test("R2 success with D1 completion failure recovers by read-only check after restart without overwriting bytes", async () => {
  const t = await outboxFixture({ entry });
  try {
    const id = (await t.reserve()).body.attachment.id;
    await trigger(t.h, "fail_ready", "NEW.state='ready'");
    try { assert.equal((await putAsset(t.h, t.alice, id)).status, 503); } finally { await t.h.db.exec("DROP TRIGGER fail_ready"); }
    const original = (await (await t.h.bucket()).list()).objects[0];
    const version = original.version; assert.equal(original.size, assetBytes.length);
    await t.h.restart();
    const checked = await t.h.request(`${route(id)}/check`, { method: "POST", cookie: t.alice.cookie, body: {} });
    assert.equal(checked.status, 200, checked.text); assert.equal(checked.body.attachment.state, "ready");
    assert.equal((await putAsset(t.h, t.alice, id)).status, 200);
    assert.equal((await (await t.h.bucket()).list()).objects[0].version, version);
    const failure = await t.h.request(`${route(id)}/content`, { cookie: t.alice.cookie, headers: { "x-test-r2-fault": "get" } });
    assert.equal(failure.status, 503);
  } finally { await t.close(); }
});

test("terminal intent survives delete failure and D1 acknowledgement failure; cleanup is repeatable and status is consistent", async () => {
  const t = await outboxFixture({ entry });
  try {
    const asset = await t.upload(), remove = extra => t.h.request(route(asset.id), { method: "DELETE", cookie: t.alice.cookie, body: {}, ...extra });
    const failed = await remove({ headers: { "x-test-r2-fault": "delete" } });
    assert.equal(failed.status, 202); assert.equal(failed.body.attachment.state, "deleted"); assert.equal(failed.body.attachment.cleanupPending, true);
    assert.equal((await putAsset(t.h, t.alice, asset.id)).status, 409);
    await trigger(t.h, "fail_ack", "NEW.cleanup_at IS NOT NULL");
    try { assert.equal((await remove()).status, 202); } finally { await t.h.db.exec("DROP TRIGGER fail_ack"); }
    assert.equal((await (await t.h.bucket()).list()).objects.length, 0);
    await t.h.restart(); const done = await remove();
    assert.equal(done.status, 200); assert.equal(done.body.cleanupPending, false); assert.equal(done.body.attachment.cleanupPending, false);
    assert.equal((await remove()).status, 200);
    const expired = await t.upload(); await t.h.db.prepare("UPDATE outbox_assets SET expires_at=unixepoch()-1 WHERE id=?").bind(expired.id).run();
    const view = (await t.h.request(route(expired.id), { cookie: t.alice.cookie })).body.attachment;
    assert.equal(view.state, "expired"); assert.equal(view.cleanupPending, true);
  } finally { await t.close(); }
});
