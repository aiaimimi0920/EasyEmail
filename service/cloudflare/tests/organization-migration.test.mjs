import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness, newKey, seedMailbox } from "./runtime-harness.mjs";

test("M2 to M3 expand preserves exact identity, mailbox credentials, cached content and old key scopes", async () => {
  const h = await createHarness({}, false, "0002_mail.sql");
  try {
    const alice = await h.register("m2-upgrade-alice");
    const box = await seedMailbox(h, alice.id, "stable@example.test");
    const key = await newKey(h, alice.cookie, { scopes: ["mailboxes:read", "mailboxes:write", "messages:read"] });
    await h.db.prepare("UPDATE mailboxes SET credential_cipher = 'opaque-ciphertext', synced_at = 123, sync_revision = 7 WHERE id = ?").bind(box).run();
    const id = crypto.randomUUID();
    await h.db.prepare(`INSERT INTO messages
      (id,user_id,mailbox_id,remote_id,fingerprint,sender,recipient,subject,text_body,html_body,attachments,received_at,observed_at)
      VALUES (?,?,?,'remote','hash','sender@example.test','stable@example.test','保留主题','保留正文','<b>raw</b>','[]',100,101)`)
      .bind(id, alice.id, box).run();
    const tables = ["users", "sessions", "api_keys", "mailbox_creations", "mailboxes", "messages"];
    const before = {};
    for (const table of tables) before[table] = (await h.db.prepare(`SELECT * FROM ${table}`).all()).results;
    await h.migrate(); await h.migrate(); await h.restart();
    for (const table of tables) {
      const after = (await h.db.prepare(`SELECT * FROM ${table}`).all()).results;
      assert.equal(after.length, before[table].length);
      for (const [i, row] of before[table].entries()) {
        for (const [column, value] of Object.entries(row)) assert.equal(after[i][column], value, `${table}.${column}`);
      }
    }
    const result = await h.request(`/api/v1/mailboxes/${box}`, { token: key.token });
    assert.equal(result.status, 200, result.text);
    assert.equal(result.body.mailbox.displayName, "");
    assert.equal(result.body.mailbox.note, "");
    assert.equal(result.body.mailbox.favorite, false);
    assert.equal(result.body.mailbox.paused, false);
    assert.equal((await h.request("/api/v1/me", { cookie: alice.cookie })).body.user.id, alice.id);
    const detail = (await h.request(`/api/v1/mailboxes/${box}/messages/${id}`, { token: key.token })).body.message;
    assert.equal(detail.textBody, "保留正文");
    assert.deepEqual([detail.isRead, detail.starred, detail.archived], [false, false, false]);
    assert.equal((await h.request(`/api/v1/mailboxes/${box}/messages/${id}`, { method: "PATCH", token: key.token, body: { isRead: true } })).status, 403);
    console.log(`M2->M3 preservation evidence: ${h.directory}`);
  } finally { await h.close(); }
});
