import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createHarness } from "./runtime-harness.mjs";
import { allocate } from "./provider-fixture.mjs";
import { sendFixture, sendBody, sendCalls, sendRequest } from "./send-fixture.mjs";
import { draftBody, saveDraft } from "./draft-fixture.mjs";
import { retentionFixture } from "./retention-fixture.mjs";
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("0020 expands old rows without changing single-To hashes, draft revision replay or consumed draft send keys", async () => {
  const f = await sendFixture(); let h;
  try {
    h = await createHarness(f.bindings, false, "0019_subscriptions.sql");
    const user = await h.register("recipients-upgrade"), box = (await allocate(h, user.cookie)).body.mailbox;
    const key = crypto.randomUUID(), outgoingId = crypto.randomUUID(), id = crypto.randomUUID();
    const parts = [box.id, sendBody.to, sendBody.subject, sendBody.text, null], contentHash = hash(parts);
    await h.db.prepare(`INSERT INTO outgoing_messages(id,user_id,mailbox_id,request_key,request_hash,provider_id,transport,
      from_address,to_address,subject,text_body,threading,state,created_at,updated_at)
      VALUES (?,?,?,?,?,'self','binding',?,?,?,?,'none','unknown',unixepoch(),unixepoch())`)
      .bind(outgoingId, user.id, box.id, key, contentHash, box.address, sendBody.to, sendBody.subject, sendBody.text).run();
    await h.db.prepare(`INSERT INTO drafts(user_id,id,revision,mailbox_id,to_address,subject,text_body,content_hash,created_at,updated_at)
      VALUES (?,?,1,?,?,?,?,?,unixepoch(),unixepoch())`).bind(user.id, id, box.id, sendBody.to, sendBody.subject, sendBody.text, contentHash).run();
    const tables = ["outgoing_messages", "drafts", "users", "sessions", "mailboxes"], before = {};
    for (const table of tables) before[table] = (await h.db.prepare(`SELECT * FROM ${table}`).all()).results;
    await h.migrate(); await h.migrate(); await h.restart();
    for (const table of tables) {
      const rows = (await h.db.prepare(`SELECT * FROM ${table}`).all()).results;
      assert.equal(rows.length, before[table].length);
      for (const [index, row] of before[table].entries()) for (const [column, value] of Object.entries(row)) assert.deepEqual(rows[index][column], value, `${table}.${column}`);
    }
    assert.equal(await h.db.prepare("SELECT recipient_count FROM outgoing_messages").first("recipient_count"), 1);
    assert.equal(await h.db.prepare("SELECT recipients_json FROM outgoing_messages").first("recipients_json"), null);
    assert.equal((await sendRequest(h, user.cookie, box, key, { ...sendBody, cc: [], bcc: [] })).body.outgoing.state, "unknown");
    assert.equal(sendCalls(f).length, 0);
    assert.equal((await saveDraft(h, user.cookie, id, draftBody(box.id, { ...sendBody }))).status, 200, "Old expectedRevision=0 replay remains valid");
    const draftKey = crypto.randomUUID(), result = await sendRequest(h, user.cookie, box, draftKey, { ...sendBody, draftId: id, draftRevision: 1 });
    assert.equal(result.status, 201, result.text);
    assert.equal(await h.db.prepare("SELECT request_hash FROM outgoing_messages WHERE request_key=?").bind(draftKey).first("request_hash"), hash([...parts, id, 1]));
    assert.deepEqual((await h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { try { await h?.close(); } finally { await f.close(); } }
});

test("retention atomically erases all To/CC/BCC content but preserves recipient cost and unknown replay guards", async () => {
  const a = await retentionFixture(), { h, f, alice } = a;
  try {
    const box = (await allocate(h, alice.cookie)).body.mailbox, key = crypto.randomUUID();
    const body = { ...sendBody, to: ["one@example.test", "two@example.test"], bcc: ["private@example.test"] };
    f.modes.set("/cf/admin/send_mail_by_binding", "disconnect");
    const sent = await sendRequest(h, alice.cookie, box, key, body); assert.equal(sent.body.outgoing.state, "unknown", sent.text);
    await h.db.prepare("UPDATE outgoing_messages SET updated_at=unixepoch()-172800").run();
    const before = await h.db.prepare("SELECT * FROM outgoing_messages").first();
    assert.equal((await a.policy({ enabled: true, outgoingDays: 1 })).status, 200);
    await h.db.prepare("CREATE TRIGGER fail_recipient_redaction BEFORE UPDATE ON outgoing_messages WHEN NEW.recipients_json IS NULL BEGIN SELECT RAISE(ABORT,'synthetic redaction failure'); END").run();
    try { const failed = await a.run(); assert.equal(failed.status, 503); assert.equal(failed.body.error.code, "retention_storage_failed"); }
    finally { await h.db.prepare("DROP TRIGGER fail_recipient_redaction").run(); }
    assert.deepEqual(await h.db.prepare("SELECT * FROM outgoing_messages").first(), before);
    assert.equal((await a.run()).status, 200);
    const after = await h.db.prepare("SELECT * FROM outgoing_messages").first();
    assert.equal(after.recipients_json, null); assert.equal(after.to_address, ""); assert.equal(after.recipient_count, 3);
    assert.equal(after.request_hash, before.request_hash); assert.equal(after.request_key, key);
    await h.restart(); const replay = await sendRequest(h, alice.cookie, box, key, body);
    assert.equal(replay.body.outgoing.state, "unknown"); assert.equal(replay.text.includes("private@example.test"), false);
    assert.deepEqual(replay.body.outgoing.bcc, []); assert.ok(replay.body.outgoing.contentPurgedAt); assert.equal(sendCalls(f).length, 1);
  } finally { await a.close(); }
});
