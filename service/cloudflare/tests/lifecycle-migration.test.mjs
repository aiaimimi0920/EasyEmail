import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness, newKey, seedMailbox } from "./runtime-harness.mjs";

test("M3c lifecycle expand preserves old identity, encrypted credential, content, organization, scopes and unknown send guard", async () => {
  const h = await createHarness({}, false, "0005_attachment_identity.sql");
  try {
    const user = await h.register("lifecycle-upgrade-alice"), box = await seedMailbox(h, user.id, "preserved@example.test");
    const key = await newKey(h, user.cookie, { scopes: ["mailboxes:read", "mailboxes:write", "messages:read", "messages:write"] });
    await h.db.prepare("UPDATE mailboxes SET credential_cipher='opaque-cipher', paused=1, favorite=1, note='保留备注' WHERE id=?").bind(box).run();
    const messageId = crypto.randomUUID();
    await h.db.prepare(`INSERT INTO messages
      (id,user_id,mailbox_id,remote_id,fingerprint,sender,recipient,subject,text_body,html_body,attachments,received_at,observed_at,is_read,starred,archived,attachment_version)
      VALUES (?,?,?,'1','preserved-fingerprint','sender@example.test','preserved@example.test','保留主题','保留正文','<b>保留</b>','[]',123,124,1,1,1,'preserved-version')`)
      .bind(messageId, user.id, box).run();
    await h.db.prepare(`INSERT INTO outgoing_messages
      (id,user_id,mailbox_id,request_key,request_hash,provider_id,transport,from_address,to_address,subject,text_body,reply_message_id,threading,state,created_at,updated_at)
      VALUES (?,?,?,'preserved-key','preserved-hash','self','binding','preserved@example.test','recipient@example.test','保留发送','未知结果',?,'submitted','unknown',123,124)`)
      .bind(crypto.randomUUID(), user.id, box, messageId).run();
    const tables = ["users", "sessions", "api_keys", "mailboxes", "messages", "outgoing_messages"];
    const before = {};
    for (const table of tables) before[table] = (await h.db.prepare(`SELECT * FROM ${table}`).all()).results;
    await h.migrate(); await h.migrate(); await h.restart();
    for (const table of tables) {
      const after = (await h.db.prepare(`SELECT * FROM ${table}`).all()).results;
      assert.equal(after.length, before[table].length);
      for (const [i, row] of before[table].entries()) for (const [column, value] of Object.entries(row)) assert.equal(after[i][column], value, `${table}.${column}`);
    }
    const dto = (await h.request(`/api/v1/mailboxes/${box}`, { token: key.token })).body.mailbox;
    assert.equal(dto.disabled, false); assert.equal(dto.disabledAt, null); assert.equal(dto.releasedAt, null); assert.equal(dto.paused, true);
    assert.equal((await h.request(`/api/v1/mailboxes/${box}/messages/${messageId}`, { token: key.token })).body.message.trashedAt, null);
    assert.equal((await h.request(`/api/v1/mailboxes/${box}/messages/${messageId}`, { method: "DELETE", token: key.token, origin: null })).status, 403);
    assert.equal((await h.request(`/api/v1/mailboxes/${box}/lifecycle`, { method: "POST", token: key.token, origin: null,
      body: { action: "release", confirmAddress: "preserved@example.test" } })).status, 403);
    console.log(`M3c->M3d preservation evidence: ${h.directory}`);
  } finally { await h.close(); }
});
