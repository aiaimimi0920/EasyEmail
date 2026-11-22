import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness, newKey } from "./runtime-harness.mjs";
import { allocate } from "./provider-fixture.mjs";
import { attachmentMail, bytesHash, binaryRequest, downloadPath } from "./attachment-fixture.mjs";
import { sendFixture } from "./send-fixture.mjs";
import { seedLegacyCloudflare } from "./legacy-mailbox-fixture.mjs";

test("M3b expand preserves data and guards; digest backfill retains legacy ID, fingerprint and organization across restart", async () => {
  const f = await sendFixture(), h = await createHarness(f.bindings, false, "0004_outgoing.sql");
  try {
    const user = await h.register("content-upgrade-alice"), box = await seedLegacyCloudflare(h, f, user.id);
    const fixture = attachmentMail(box.address), id = crypto.randomUUID(), remote = fixture.parsed;
    const attachments = remote.attachments.map(({ index, sha256, ...metadata }) => metadata);
    const legacy = { remoteId: "71", recipient: box.address, sender: remote.sender, subject: remote.subject,
      textBody: remote.text, htmlBody: remote.html, attachments, receivedAt: Date.parse("2026-10-28T01:00:00Z") / 1000 };
    const fingerprint = bytesHash(JSON.stringify(legacy));
    await h.db.prepare(`INSERT INTO messages
      (id,user_id,mailbox_id,remote_id,fingerprint,sender,recipient,subject,text_body,html_body,attachments,received_at,observed_at,is_read,starred,archived,rfc_message_id)
      VALUES (?,?,?,'71',?,?,?,?,?,?,?,?,123,1,1,1,'<preserved@example.test>')`)
      .bind(id, user.id, box.id, fingerprint, remote.sender, box.address, remote.subject, remote.text, remote.html,
        JSON.stringify(attachments), legacy.receivedAt).run();
    const key = await newKey(h, user.cookie, { scopes: ["mailboxes:read", "messages:read", "messages:send"] });
    // Seed the actual old schema directly: current business handlers require all current expand migrations.
    await h.db.prepare(`INSERT INTO outgoing_messages
      (id,user_id,mailbox_id,request_key,request_hash,provider_id,transport,from_address,to_address,subject,text_body,threading,state,error_code,created_at,updated_at)
      VALUES (?,?,?,?,?,'self','binding',?,'recipient@example.test','Preserved guard','synthetic','none','unknown','synthetic_uncertain',123,123)`)
      .bind(crypto.randomUUID(), user.id, box.id, crypto.randomUUID(), "preserved-request-hash", box.address).run();
    const tables = ["users", "sessions", "api_keys", "mailboxes", "mailbox_creations", "messages", "outgoing_messages"];
    const before = {};
    for (const table of tables) before[table] = (await h.db.prepare(`SELECT * FROM ${table}`).all()).results;
    await h.migrate(); await h.migrate(); await h.restart();
    for (const table of tables) {
      const after = (await h.db.prepare(`SELECT * FROM ${table}`).all()).results;
      assert.equal(after.length, before[table].length);
      for (const [i, row] of before[table].entries()) for (const [column, value] of Object.entries(row)) {
        assert.equal(after[i][column], value, `${table}.${column}`);
      }
    }
    assert.equal((await binaryRequest(h, downloadPath(box, { id }), "", { authorization: `Bearer ${key.token}` })).status, 403);
    f.messages.set(box.address, [remote]); f.rawMails.set(box.address, [fixture.raw]);
    const sync = () => h.request(`/api/v1/mailboxes/${box.id}/sync`, { cookie: user.cookie, method: "POST", body: {} });
    assert.equal((await sync()).body.sync.inserted, 0);
    const backfill = await h.db.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
    for (const [column, value] of Object.entries(before.messages[0])) if (column !== "attachments") assert.equal(backfill[column], value, column);
    assert.equal(JSON.parse(backfill.attachments)[0].sha256, bytesHash(fixture.bytes));
    assert.ok(backfill.attachment_version);
    assert.equal((await h.db.prepare("SELECT COUNT(*) AS n FROM messages").first()).n, 1);
    assert.equal((await sync()).body.sync.inserted, 0);
    // An old provider without the new fields must not erase already verified metadata.
    f.messages.set(box.address, [{ ...remote, attachments }]);
    assert.equal((await sync()).body.sync.inserted, 0);
    assert.equal((await h.db.prepare("SELECT attachments FROM messages WHERE id = ?").bind(id).first()).attachments, backfill.attachments);
    await h.restart();
    assert.deepEqual((await binaryRequest(h, downloadPath(box, { id }), user.cookie)).bytes, fixture.bytes);
    const retained = (await h.db.prepare("SELECT * FROM outgoing_messages").all()).results;
    assert.deepEqual(retained.map(({ content_purged_at, recipients_json, recipient_count, attachments_json, ...row }) => {
      assert.deepEqual([content_purged_at, recipients_json, recipient_count, attachments_json], [null, null, 1, null]); return row;
    }), before.outgoing_messages);
    console.log(`M3b->M3c preservation evidence: ${h.directory}`);
  } finally { await h.close(); await f.close(); }
});

test("digest UPDATE and INSERT share the existing lease fence and D1 transaction, without partial backfill", async () => {
  const f = await sendFixture(), h = await createHarness(f.bindings);
  try {
    const user = await h.register("content-atomic-alice"), box = (await allocate(h, user.cookie)).body.mailbox;
    const fixture = attachmentMail(box.address);
    const legacy = { ...fixture.parsed, attachments: fixture.parsed.attachments.map(({ index, sha256, ...item }) => item) };
    f.messages.set(box.address, [legacy]);
    const sync = () => h.request(`/api/v1/mailboxes/${box.id}/sync`, { cookie: user.cookie, method: "POST", body: {} });
    assert.equal((await sync()).status, 200);
    const old = await h.db.prepare("SELECT * FROM messages LIMIT 1").first();
    f.messages.set(box.address, [fixture.parsed, { ...fixture.parsed, id: 72, subject: "Later insert fails the whole batch" }]);
    await h.db.prepare("CREATE TRIGGER fail_attachment_insert BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'synthetic atomic failure'); END").run();
    try { assert.equal((await sync()).body.error.code, "sync_storage_failed"); }
    finally { await h.db.prepare("DROP TRIGGER fail_attachment_insert").run(); }
    assert.deepEqual(await h.db.prepare("SELECT * FROM messages LIMIT 1").first(), old);
    f.messages.set(box.address, [fixture.parsed]);
    const gate = f.hold("/cf/api/parsed_mails"), pending = sync();
    try {
      await gate.entered;
      await h.db.prepare("UPDATE mailboxes SET sync_token = 'successor', sync_lease_until = unixepoch() + 60 WHERE id = ?").bind(box.id).run();
    } finally { gate.release(); }
    assert.equal((await pending).body.error.code, "sync_lease_lost");
    assert.deepEqual(await h.db.prepare("SELECT * FROM messages LIMIT 1").first(), old);
    assert.equal((await h.db.prepare("SELECT sync_token FROM mailboxes WHERE id = ?").bind(box.id).first()).sync_token, "successor");
  } finally { await h.close(); await f.close(); }
});
