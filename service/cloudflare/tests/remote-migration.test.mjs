import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness, newKey } from "./runtime-harness.mjs";
import { allocate } from "./provider-fixture.mjs";
import { remoteFixture } from "./remote-fixture.mjs";
import { createHash } from "node:crypto";

test("0011 expands legacy data without upgrading a body match to remote identity; repeated migration/restart preserves guards", async () => {
  const f = await remoteFixture(); let h;
  try {
    h = await createHarness(f.bindings, false, "0010_creation_history.sql");
    const user = await h.register("remote-migration-alice"), box = (await allocate(h, user.cookie)).body.mailbox;
    const key = await newKey(h, user.cookie, { scopes: ["messages:read", "messages:delete"] });
    const mail = await f.seed(box.address, 1), id = crypto.randomUUID();
    const legacy = { remoteId: "1", recipient: box.address, sender: mail.sender, subject: mail.subject,
      textBody: mail.text, htmlBody: mail.html, attachments: mail.attachments, receivedAt: Math.floor(Date.parse(mail.created_at) / 1000) };
    const fingerprint = createHash("sha256").update(JSON.stringify(legacy)).digest("hex");
    await h.db.prepare(`INSERT INTO messages(id,user_id,mailbox_id,remote_id,fingerprint,sender,recipient,subject,text_body,html_body,attachments,received_at,observed_at)
      VALUES(?,?,?,'1',?,?,?,?,?,?,?,?,123)`)
      .bind(id, user.id, box.id, fingerprint, mail.sender, box.address, mail.subject, mail.text, mail.html, JSON.stringify(mail.attachments), legacy.receivedAt).run();
    const tables = ["users", "sessions", "api_keys", "mailboxes", "mailbox_creations", "messages"];
    const before = {};
    for (const table of tables) before[table] = (await h.db.prepare(`SELECT * FROM ${table}`).all()).results;
    await h.migrate(); await h.migrate(); await h.restart();
    for (const table of tables) {
      const rows = (await h.db.prepare(`SELECT * FROM ${table}`).all()).results;
      assert.equal(rows.length, before[table].length);
      for (const [index, row] of before[table].entries()) for (const [column, value] of Object.entries(row)) assert.equal(rows[index][column], value, `${table}.${column}`);
    }
    const old = await h.db.prepare("SELECT * FROM messages WHERE id=?").bind(id).first();
    assert.equal(old.source_version, null); assert.equal(old.remote_delete_enabled, 0);
    assert.deepEqual(JSON.parse((await h.db.prepare("SELECT scopes FROM api_keys WHERE id=?").bind(key.id).first()).scopes), ["messages:read", "messages:delete"]);
    const sync = () => h.request(`/api/v1/mailboxes/${box.id}/sync`, { method: "POST", cookie: user.cookie, body: {} });
    assert.equal((await sync()).body.sync.inserted, 1); assert.equal((await sync()).body.sync.inserted, 0);
    assert.deepEqual(await h.db.prepare("SELECT * FROM messages WHERE id=?").bind(id).first(), old);
    const current = await h.db.prepare("SELECT * FROM messages WHERE id!=?").bind(id).first();
    const messagePath = `/api/v1/mailboxes/${box.id}/messages/${current.id}`;
    await h.request(messagePath, { method: "DELETE", cookie: user.cookie });
    const removed = await h.request(`${messagePath}/remote-delete`, { method: "POST", cookie: user.cookie,
      body: { confirmAddress: box.address, confirmMessageId: current.id }, headers: { "idempotency-key": crypto.randomUUID() } });
    assert.equal(removed.body.deletion.state, "deleted", removed.text);
    const guard = await h.db.prepare("SELECT * FROM remote_deletions").first();
    await h.migrate(); await h.restart();
    assert.deepEqual(await h.db.prepare("SELECT * FROM remote_deletions").first(), guard);
    // An old read projection remains valid against the expanded schema.
    assert.equal((await h.db.prepare("SELECT id,fingerprint,text_body FROM messages WHERE id=?").bind(id).first()).text_body, mail.text);
    console.log(`M3i->M3j preservation evidence: ${h.directory}`);
  } finally { await h?.close(); await f.close(); }
});
