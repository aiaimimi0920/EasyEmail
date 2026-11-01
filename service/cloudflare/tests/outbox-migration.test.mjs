import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { assetRef, outboxFixture } from "./outbox-fixture.mjs";
import { sendBody, sendCalls, sendRequest } from "./send-fixture.mjs";
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("0021 preserves W7 data and exact empty-attachment hashes, draft replay and original unknown send guards", async () => {
  const t = await outboxFixture({ through: "0020_outgoing_recipients.sql" });
  try {
    const parts = [t.box.id, sendBody.to, sendBody.subject, sendBody.text, null], key = crypto.randomUUID(), draftId = crypto.randomUUID();
    await t.h.db.prepare(`INSERT INTO outgoing_messages(id,user_id,mailbox_id,request_key,request_hash,provider_id,transport,
      from_address,to_address,subject,text_body,threading,state,created_at,updated_at)
      VALUES(?,?,?,?,?,'self','binding',?,?,?,?,'none','unknown',unixepoch(),unixepoch())`)
      .bind(crypto.randomUUID(), t.alice.id, t.box.id, key, hash(parts), t.box.address, sendBody.to, sendBody.subject, sendBody.text).run();
    await t.h.db.prepare(`INSERT INTO drafts(user_id,id,revision,mailbox_id,to_address,subject,text_body,content_hash,created_at,updated_at)
      VALUES(?,?,1,?,?,?,?,?,unixepoch(),unixepoch())`).bind(t.alice.id, draftId, t.box.id, sendBody.to, sendBody.subject, sendBody.text, hash(parts)).run();
    const before = {};
    for (const name of ["drafts", "outgoing_messages", "users", "sessions", "mailboxes", "api_keys"]) before[name] = (await t.h.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()).results;
    await t.h.migrate(); await t.h.migrate(); await t.h.restart();
    for (const [name, rows] of Object.entries(before)) {
      const current = (await t.h.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()).results;
      let projected = ["drafts", "outgoing_messages"].includes(name) ? current.map(({ attachments_json, ...legacy }) => {
        assert.equal(attachments_json, null); return legacy;
      }) : current;
      if (name === "drafts") projected = projected.map(({ normal_account_id, normal_account_revision, normal_reply_message_id, normal_attachments_json, ...legacy }) => {
        assert.equal(normal_account_id, null); assert.equal(normal_account_revision, null); assert.equal(normal_reply_message_id, null); assert.equal(normal_attachments_json, null); return legacy;
      });
      assert.deepEqual(projected, rows, name);
    }
    assert.equal((await sendRequest(t.h, t.alice.cookie, t.box, key, { ...sendBody, attachments: [] })).body.outgoing.state, "unknown");
    const saved = await t.h.request(`/api/v1/drafts/${draftId}`, { method: "PUT", cookie: t.alice.cookie,
      body: { expectedRevision: 0, mailboxId: t.box.id, ...sendBody, attachments: [] } });
    assert.equal(saved.status, 200, saved.text); assert.equal(saved.body.draft.revision, 1);
    const draftKey = crypto.randomUUID(), sent = await sendRequest(t.h, t.alice.cookie, t.box, draftKey, { ...sendBody, attachments: [], draftId, draftRevision: 1 });
    assert.equal(sent.status, 201, sent.text);
    assert.equal(await t.h.db.prepare("SELECT request_hash FROM outgoing_messages WHERE request_key=?").bind(draftKey).first("request_hash"), hash([...parts, draftId, 1]));
    assert.equal(sendCalls(t.f).length, 1); assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM outbox_assets").first("n"), 0);
    assert.deepEqual((await t.h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await t.close(); }
});

test("retention atomically removes outgoing attachment manifests but preserves content hashes, quotas and no-resend guards", async () => {
  const t = await outboxFixture();
  try {
    await t.h.db.prepare("INSERT INTO platform_admins(user_id,created_at) VALUES(?,unixepoch())").bind(t.alice.id).run();
    const asset = await t.upload(), key = crypto.randomUUID(), body = { ...sendBody, bcc: ["private@example.test"], attachments: [assetRef(asset)] };
    t.f.modes.set("/cf/admin/send_mail_by_binding", "disconnect");
    assert.equal((await sendRequest(t.h, t.alice.cookie, t.box, key, body)).body.outgoing.state, "unknown");
    await t.h.db.exec("UPDATE outgoing_messages SET updated_at=unixepoch()-172800");
    const before = await t.h.db.prepare("SELECT * FROM outgoing_messages").first();
    const state = (await t.h.request("/api/v1/admin/retention", { cookie: t.alice.cookie })).body;
    const changed = await t.h.request("/api/v1/admin/retention", { method: "PUT", cookie: t.alice.cookie,
      body: { expectedRevision: state.revision, policy: { ...state.policy, enabled: true, outgoingDays: 1 }, confirm: "APPLY RETENTION" } });
    assert.equal(changed.status, 200, changed.text);
    const run = () => t.h.request("/api/v1/admin/retention/run", { method: "POST", cookie: t.alice.cookie,
      headers: { "idempotency-key": crypto.randomUUID() }, body: { expectedRevision: changed.body.revision, confirm: "RUN RETENTION" } });
    await t.h.db.exec("CREATE TRIGGER fail_asset_redaction BEFORE UPDATE ON outgoing_messages WHEN NEW.attachments_json IS NULL BEGIN SELECT RAISE(ABORT,'synthetic redaction failure'); END");
    try { assert.equal((await run()).status, 503); } finally { await t.h.db.exec("DROP TRIGGER fail_asset_redaction"); }
    assert.deepEqual(await t.h.db.prepare("SELECT * FROM outgoing_messages").first(), before);
    assert.equal((await run()).status, 200);
    const after = await t.h.db.prepare("SELECT * FROM outgoing_messages").first(); assert.equal(after.attachments_json, null);
    for (const field of ["request_key", "request_hash", "recipient_count", "state", "created_at"]) assert.equal(after[field], before[field], field);
    await t.h.db.exec("UPDATE outbox_assets SET expires_at=unixepoch()-1"); await t.h.scheduled(); await t.h.restart();
    const replay = await sendRequest(t.h, t.alice.cookie, t.box, key, body);
    assert.equal(replay.body.outgoing.state, "unknown"); assert.deepEqual(replay.body.outgoing.attachments, []);
    assert.equal(replay.text.includes(asset.filename), false); assert.equal(sendCalls(t.f).length, 1);
  } finally { await t.close(); }
});
