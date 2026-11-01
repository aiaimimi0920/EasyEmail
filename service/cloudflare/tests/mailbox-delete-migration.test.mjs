import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { mailboxDeleteFixture } from "./mailbox-delete-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";

test("0012 is expand-only: old credentials/content/guards/scopes survive and new receipts persist across repeated migration and restart", async () => {
  const t = await mailboxDeleteFixture(false, "0011_remote_deletions.sql");
  try {
    const s = await t.sample(), unknown = await t.sample(), mail = await t.f.seed(s.box.address, s.remoteId);
    const oldKey = await newKey(t.h, t.alice.cookie, { scopes: ["mailboxes:read", "mailboxes:delete", "messages:remote-delete"] });
    // Seed historical writer rows: current sync/send writers require all current migrations.
    const message = { id: crypto.randomUUID() };
    const version = await t.f.db.prepare("SELECT version FROM raw_mail_resources WHERE mail_id=?").bind(s.remoteId).first("version");
    await t.h.db.prepare(`INSERT INTO messages(id,user_id,mailbox_id,remote_id,fingerprint,sender,recipient,subject,text_body,html_body,
      attachments,received_at,observed_at,rfc_message_id,source_version,remote_delete_enabled)
      VALUES(?,?,?,?,?,?,?,?,?,?,'[]',unixepoch(),unixepoch(),?,?,1)`)
      .bind(message.id,t.alice.id,s.box.id,String(s.remoteId),crypto.randomUUID(),mail.sender,s.box.address,mail.subject,mail.text,mail.html,
        `<${s.remoteId}@synthetic.test>`,version).run();
    const messagePath = `${s.path}/messages/${message.id}`;
    await t.h.request(messagePath, { method: "DELETE", cookie: t.alice.cookie });
    const removed = await t.h.request(`${messagePath}/remote-delete`, { method: "POST", cookie: t.alice.cookie,
      body: { confirmAddress: s.box.address, confirmMessageId: message.id }, headers: { "idempotency-key": crypto.randomUUID() } });
    assert.equal(removed.body.deletion.state, "deleted", removed.text);
    for (const box of [s, unknown]) {
      const to = "recipient@example.test", subject = "Synthetic migration", text = "Local fixture only";
      const hash = createHash("sha256").update(JSON.stringify([box.box.id, to, subject, text, null])).digest("hex");
      await t.h.db.prepare(`INSERT INTO outgoing_messages
        (id,user_id,mailbox_id,request_key,request_hash,provider_id,transport,from_address,to_address,subject,text_body,
          threading,state,error_code,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'worker',?,?,?,?,'none',?,?,unixepoch(),unixepoch())`)
        .bind(crypto.randomUUID(), t.alice.id, box.box.id, crypto.randomUUID(), hash, box.box.providerId, box.box.address,
          to, subject, text, box === unknown ? "unknown" : "accepted", box === unknown ? "provider_unavailable" : null).run();
    }
    const tables = (await t.h.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all())
      .results.map((row) => row.name);
    assert.equal(tables.includes("remote_mailbox_deletions"), false);
    const before = {};
    for (const table of tables) { assert.match(table, /^[a-z_]+$/); before[table] = (await t.h.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results; }
    for (const name of ["mailboxes", "messages", "mailbox_creations", "outgoing_messages", "remote_deletions", "api_keys"]) assert.ok(before[name].length);
    await t.h.migrate(); await t.h.migrate(); await t.h.restart();
    for (const table of tables) {
      const current = (await t.h.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
      const rows = table === "messages" ? current.map(({ thread_key, thread_basis, thread_version, thread_limited, ...legacy }) => {
        assert.deepEqual([thread_key, thread_basis, thread_version, thread_limited], [null, null, 0, 0]); return legacy;
      }) : table === "outgoing_messages" ? current.map(({ recipients_json, recipient_count, attachments_json, ...legacy }) => {
        assert.deepEqual([recipients_json, recipient_count, attachments_json], [null, 1, null]); return legacy;
      }) : current;
      assert.deepEqual(rows, before[table], table);
    }
    assert.equal((await t.h.db.prepare("SELECT COUNT(*) AS n FROM remote_mailbox_deletions").first()).n, 0);
    assert.equal((await t.remove(s, undefined, { token: oldKey.token })).status, 403);
    assert.equal((await t.remove(unknown)).body.error.code, "mailbox_external_operation_unresolved");
    const key = crypto.randomUUID(), result = await t.remove(s, key); assert.equal(result.body.deletion.state, "deleted", result.text);
    const guard = await t.h.db.prepare("SELECT * FROM remote_mailbox_deletions WHERE mailbox_id=?").bind(s.box.id).first();
    const count = t.writes().length;
    await t.h.migrate(); await t.h.restart();
    assert.deepEqual(await t.h.db.prepare("SELECT * FROM remote_mailbox_deletions WHERE mailbox_id=?").bind(s.box.id).first(), guard);
    assert.deepEqual((await t.remove(s, key)).body, result.body); assert.equal(t.writes().length, count);
    assert.equal((await t.h.db.prepare("SELECT credential_cipher FROM mailboxes WHERE id=?").bind(unknown.box.id).first()).credential_cipher,
      before.mailboxes.find((row) => row.id === unknown.box.id).credential_cipher);
    assert.equal((await t.h.request(s.path, { cookie: t.alice.cookie })).body.mailbox.releasedAt !== null, true);
    assert.equal((await t.h.db.prepare("SELECT id,text_body FROM messages WHERE id=?").bind(message.id).first()).text_body,
      before.messages.find((row) => row.id === message.id).text_body);
    console.log(`M3j->M3k expand-only evidence: ${t.h.directory}`);
  } finally { await t.close(); }
});
