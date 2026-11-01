import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "./runtime-harness.mjs";
import { allocate } from "./provider-fixture.mjs";
import { sendFixture, sendBody, sendRequest, sendCalls } from "./send-fixture.mjs";
import { saveDraft, draftBody } from "./draft-fixture.mjs";
import { selectGates } from "./account-race-fixture.mjs";

const content = { ...sendBody, cc: ["copy@example.test"], bcc: ["private@example.test"] };
test("multi-recipient concurrent same-key replay, body conflict and storage failure never issue a second dispatch", async () => {
  const f = await sendFixture(); let h, gate, pending;
  try {
    h = await createHarness(f.bindings); const user = await h.register("recipients-race"), box = (await allocate(h, user.cookie)).body.mailbox;
    const key = crypto.randomUUID(); gate = f.hold("/cf/admin/send_mail_by_binding");
    pending = sendRequest(h, user.cookie, box, key, content); await gate.entered;
    assert.equal((await sendRequest(h, user.cookie, box, key, content)).body.outgoing.state, "pending");
    assert.equal((await sendRequest(h, user.cookie, box, key, { ...content, bcc: ["other@example.test"] })).status, 409);
    await h.db.exec("CREATE TRIGGER fail_recipient_result BEFORE UPDATE ON outgoing_messages BEGIN SELECT RAISE(ABORT,'synthetic storage unavailable'); END");
    gate.release(); const result = await pending; pending = null;
    assert.equal(result.body.outgoing.state, "unknown");
    await h.db.exec("DROP TRIGGER fail_recipient_result"); await h.restart();
    assert.equal((await sendRequest(h, user.cookie, box, key, content)).status, 202);
    assert.equal(sendCalls(f).length, 1);
  } finally { gate?.release(); await pending?.catch(() => {}); try { await h?.close(); } finally { await f.close(); } }
});

test("CC/BCC edits after authorization fence reservation; draft consumption failure rolls back recipient cost and guard", async () => {
  const f = await sendFixture(), gates = await selectGates(); let h, gate, pending;
  try {
    h = await createHarness({ ...f.bindings, ...gates.bindings }, false, null, new URL("./account-gated-worker.ts", import.meta.url));
    const user = await h.register("recipient-draft-race"), box = (await allocate(h, user.cookie)).body.mailbox;
    const id = crypto.randomUUID(); assert.equal((await saveDraft(h, user.cookie, id, draftBody(box.id, content))).status, 201);
    gate = gates.hold("recipient-edit", "draft");
    pending = sendRequest(h, user.cookie, box, crypto.randomUUID(), { ...content, draftId: id, draftRevision: 1 },
      { headers: { ...gate.headers, "idempotency-key": crypto.randomUUID() } });
    await gate.entered();
    assert.equal((await saveDraft(h, user.cookie, id, draftBody(box.id, { ...content, bcc: ["new@example.test"], expectedRevision: 1 }))).status, 200);
    gate.release(); assert.equal((await pending).body.error.code, "draft_changed"); pending = null;
    await h.db.exec("CREATE TRIGGER fail_recipient_consume BEFORE UPDATE ON drafts WHEN NEW.state='submitted' BEGIN SELECT RAISE(ABORT,'synthetic consume failure'); END");
    const key = crypto.randomUUID(), body = { ...content, bcc: ["new@example.test"], draftId: id, draftRevision: 2 };
    try { assert.equal((await sendRequest(h, user.cookie, box, key, body)).status, 500); }
    finally { await h.db.exec("DROP TRIGGER fail_recipient_consume"); }
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM outgoing_messages").first("n"), 0); assert.equal(sendCalls(f).length, 0);
    assert.equal(await h.db.prepare("SELECT state FROM drafts WHERE id=?").bind(id).first("state"), "editing");
    const results = await Promise.all([1, 2].map(() => sendRequest(h, user.cookie, box, crypto.randomUUID(), body)));
    assert.deepEqual(results.map(r => r.status).sort(), [201, 409]); assert.equal(sendCalls(f).length, 1);
  } finally { gate?.release(); await pending?.catch(() => {}); await h?.close(); await gates.close(); await f.close(); }
});
