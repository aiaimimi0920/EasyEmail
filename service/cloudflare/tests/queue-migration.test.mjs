import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { queueFixture } from "./queue-fixture.mjs";
import { sendBody, sendRequest } from "./send-fixture.mjs";

test("0022 expands with old identities, drafts, attachments and outgoing bytes unchanged", async () => {
  const t = await queueFixture({ through: "0021_outbox_attachments.sql" });
  try {
    const asset = await t.upload(); assert.ok(asset.version);
    // Seed the historical format directly: current send code requires the latest quota view.
    const key = crypto.randomUUID(), outgoingId = crypto.randomUUID();
    const digest = createHash("sha256").update(JSON.stringify([t.box.id, sendBody.to, sendBody.subject, sendBody.text, null])).digest("hex");
    await t.h.db.prepare(`INSERT INTO outgoing_messages(id,user_id,mailbox_id,request_key,request_hash,provider_id,transport,
      from_address,to_address,subject,text_body,threading,state,created_at,updated_at)
      VALUES (?,?,?,?,?,'self','binding',?,?,?,?,'none','accepted',unixepoch(),unixepoch())`)
      .bind(outgoingId, t.alice.id, t.box.id, key, digest, t.box.address, sendBody.to, sendBody.subject, sendBody.text).run();
    // Current draft writers require the additive source columns; preserve a real 0021-format row instead.
    await t.h.db.prepare(`INSERT INTO drafts(user_id,id,revision,mailbox_id,to_address,subject,text_body,content_hash,created_at,updated_at)
      VALUES (?,?,1,?,?,?,?,?,unixepoch(),unixepoch())`)
      .bind(t.alice.id, crypto.randomUUID(), t.box.id, sendBody.to, sendBody.subject, sendBody.text, digest).run();
    const tables = ["users", "sessions", "mailboxes", "mailbox_creations", "outgoing_messages", "drafts", "outbox_assets"];
    const rows = {};
    for (const name of tables) rows[name] = (await t.h.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()).results;
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='send_jobs'").first("n"), 0);
    await t.h.migrate(); await t.h.migrate();
    for (const name of tables) {
      const current = (await t.h.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()).results;
      const legacy = name === "drafts" ? current.map(({ normal_account_id, normal_account_revision, normal_reply_message_id, normal_attachments_json, ...row }) => {
        assert.equal(normal_account_id, null); assert.equal(normal_account_revision, null); assert.equal(normal_reply_message_id, null); assert.equal(normal_attachments_json, null); return row;
      }) : current;
      assert.deepEqual(legacy, rows[name], name);
    }
    assert.deepEqual((await t.h.db.prepare("PRAGMA foreign_key_check").all()).results, []);
    const replay = await sendRequest(t.h, t.alice.cookie, t.box, key);
    assert.equal(replay.status, 200, replay.text); assert.equal(replay.body.outgoing.id, outgoingId);
    assert.equal((await t.enqueue()).status, 201);
  } finally { await t.close(); }
});

test("terminal queue content follows outgoing policy while immutable replay guards survive", async () => {
  const t = await queueFixture();
  try {
    const key = crypto.randomUUID(), cancelled = (await t.enqueue(sendBody, key)).body.job;
    await t.action(cancelled, "cancel");
    const sent = (await t.enqueue()).body.job; await t.tick();
    const active = (await t.enqueue({ ...sendBody, scheduledAt: Math.floor(Date.now() / 1000) + 600 })).body.job;
    await t.h.db.exec("UPDATE send_jobs SET updated_at=unixepoch()-3*86400");
    await t.h.db.exec("UPDATE outgoing_messages SET updated_at=unixepoch()-3*86400");
    await t.h.db.exec("UPDATE retention_policy SET enabled=1,outgoing_days=1,cache_days=0,trash_days=0,audit_days=0");
    await t.h.scheduled();
    for (const id of [cancelled.id, sent.id]) {
      const row = await t.h.db.prepare("SELECT * FROM send_jobs WHERE id=?").bind(id).first();
      assert.equal(row.payload_json, null); assert.equal(row.attachments_json, null); assert.ok(row.content_purged_at);
    }
    assert.ok((await t.h.db.prepare("SELECT payload_json FROM send_jobs WHERE id=?").bind(active.id).first()).payload_json);
    const replay = await t.enqueue(sendBody, key); assert.equal(replay.status, 200); assert.equal(replay.body.job.state, "cancelled");
    assert.equal(replay.body.job.content, null);
  } finally { await t.close(); }
});
