import assert from "node:assert/strict";
import { test } from "node:test";
import { normalSendFixture, mailInput } from "./normal-send-fixture.mjs";

async function saved(t) {
  const id = crypto.randomUUID(), path = `${t.path}/drafts/${id}`;
  const body = { expectedRevision: 0, accountRevision: 1, to: mailInput.to, subject: mailInput.subject, text: mailInput.text };
  const response = await t.h.request(path, { cookie: t.alice.cookie, method: "PUT", body }); assert.equal(response.status, 201, response.text);
  return { id, path, body, send: { ...mailInput, draftId: id, draftRevision: 1 } };
}
test("ordinary draft CAS, parallel fresh send keys and consume rollback permit exactly one dispatcher", async () => {
  const t = await normalSendFixture();
  try {
    await t.configure(); const d = await saved(t);
    const edits = await Promise.all(["a", "b"].map(text => t.h.request(d.path, { cookie: t.alice.cookie, method: "PUT", body: { ...d.body, expectedRevision: 1, text } })));
    assert.deepEqual(edits.map(row => row.status).sort(), [200, 409]);
    assert.equal((await t.send(d.send)).status, 409); assert.equal(t.opens.length, 0);
    const next = await saved(t), sends = await Promise.all([1, 2].map(() => t.send(next.send)));
    assert.deepEqual(sends.map(row => row.status).sort(), [201, 409]); assert.equal(t.opens.length, 1);
    const rollback = await saved(t);
    await t.h.db.prepare("CREATE TRIGGER fail_normal_draft BEFORE UPDATE ON drafts WHEN NEW.state='submitted' BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END").run();
    const failed = await t.send(rollback.send); assert.equal(failed.body.error.code, "normal_send_storage_failed");
    assert.equal((await t.h.request(rollback.path, { cookie: t.alice.cookie })).body.draft.state, "editing");
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_outgoing_messages").first("n"), 1); assert.equal(t.opens.length, 1);
    await t.h.db.prepare("DROP TRIGGER fail_normal_draft").run(); assert.equal((await t.send(rollback.send)).status, 201);
    assert.equal(t.opens.length, 2);
  } finally { await t.close(); }
});

test("ordinary draft and account mutations between precheck and send batch cannot open SMTP", async () => {
  for (const race of ["draft-edit", "draft-delete", "account", "deleted", "disabled", "smtp", "secret", "source", "user"]) {
    const t = await normalSendFixture();
    try {
      await t.configure(); const d = await saved(t), key = crypto.randomUUID();
      const response = await t.send(d.send, key, { headers: { "idempotency-key": key, "x-test-smtp-race": race } });
      assert.equal(response.status, 409, response.text); assert.equal(t.opens.length, 0);
      assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_outgoing_messages").first("n"), 0);
      const row = await t.h.db.prepare("SELECT * FROM drafts WHERE id=?").bind(d.id).first(); assert.notEqual(row.state, "submitted");
    } finally { await t.close(); }
  }
});

test("ordinary draft source changes after validation cannot create or overwrite a draft", async () => {
  for (const [race, create] of [["account", false], ["deleted", false], ["user", false], ["account", true], ["deleted", true], ["user", true]]) {
    const t = await normalSendFixture();
    try {
      const d = await saved(t);
      const path = create ? `${t.path}/drafts/${crypto.randomUUID()}` : d.path;
      const response = await t.h.request(path, { cookie: t.alice.cookie, method: "PUT", headers: { "x-test-smtp-race": race }, body: { ...d.body, expectedRevision: create ? 0 : 1, text: "must not save" } });
      assert.ok([404, 409].includes(response.status), response.text);
      const row = await t.h.db.prepare("SELECT * FROM drafts WHERE id=?").bind(d.id).first(); assert.equal(row.revision, 1); assert.equal(row.text_body, d.body.text);
      assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM drafts").first("n"), 1);
    } finally { await t.close(); }
  }
});

test("ordinary draft original-key duplicates read pending guards and finish-write failure never releases the draft", async () => {
  const t = await normalSendFixture(); let gate;
  try {
    await t.configure(); const d = await saved(t), key = crypto.randomUUID(); gate = t.hold();
    const sending = t.send(d.send, key, { headers: { "idempotency-key": key, "x-test-smtp-finish-failure": "1" } }); await gate.entered;
    const duplicate = await t.send(d.send, key); assert.equal(duplicate.body.outgoing.state, "pending");
    assert.equal((await t.send({ ...d.send, draftRevision: 2 }, key)).body.error.code, "idempotency_conflict");
    assert.equal((await t.send(d.send)).body.error.code, "draft_submitted"); gate.release();
    assert.equal((await sending).body.outgoing.state, "unknown");
    assert.equal((await t.h.request(d.path, { cookie: t.alice.cookie })).body.draft.state, "submitted");
    await t.h.db.prepare("UPDATE normal_outgoing_messages SET created_at=created_at-61").run(); await t.h.restart();
    assert.equal((await t.send(d.send, key)).body.outgoing.state, "unknown"); assert.equal(t.opens.length, 1);
  } finally { gate?.release(); await t.close(); }
});
