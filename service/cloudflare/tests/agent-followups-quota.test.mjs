import assert from "node:assert/strict";
import { test } from "node:test";
import { agentFollowupsFixture } from "./agent-followups-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";

test("follow-up and normal SMTP racing for the last shared recipient slot open only one socket", async () => {
  const t = await agentFollowupsFixture();
  try {
    const task = expect(await t.enqueue(), 201).task; await t.run(); expect(await t.configure()); expect(await t.send(), 201);
    const followup = expect(await t.followup(task.id, await t.followupInput(task.id)), 201).followup;
    const [, normal] = await Promise.all([t.run(), t.send()]); assert.ok([201, 409].includes(normal.status), normal.text);
    assert.equal(expect(await t.followupRead(followup.id)).followup.state, normal.status === 201 ? "queued" : "accepted");
    assert.equal(t.messages.length, 3); assert.equal(t.opens.length, 3);
    assert.equal(await t.h.db.prepare("SELECT SUM(recipient_count) n FROM send_recipient_charges WHERE created_at>=unixepoch()-60").first("n"), 3);
  } finally { await t.close(); }
});

test("legacy task reservation consumes the same quota before follow-up dispatch, with no premature queued charge", async () => {
  const t = await agentFollowupsFixture();
  try {
    const task = expect(await t.enqueue(), 201).task; await t.run(); expect(await t.configure()); expect(await t.send(), 201);
    const followup = expect(await t.followup(task.id, await t.followupInput(task.id)), 201).followup;
    const next = expect(await t.enqueue(), 201).task;
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM send_recipient_charges").first("n"), 2);
    await t.run(); assert.equal(expect(await t.read(next.id)).task.state, "accepted");
    assert.equal(expect(await t.followupRead(followup.id)).followup.state, "queued"); assert.equal(t.opens.length, 3);
    assert.equal(expect(await t.followupRead(followup.id)).followup.error, "send_quota_exceeded");
  } finally { await t.close(); }
});

test("retention redacts terminal follow-up content but keeps routing hash, original key, RFC identity and submission charge", async () => {
  const t = await agentFollowupsFixture();
  try {
    const task = expect(await t.enqueue(), 201).task; await t.run(); const input = await t.followupInput(task.id), key = crypto.randomUUID();
    const followup = expect(await t.followup(task.id, input, key), 201).followup; await t.run();
    await t.h.db.prepare("UPDATE retention_policy SET enabled=1,outgoing_days=1,revision=revision+1 WHERE id=1").run();
    await t.h.db.prepare("UPDATE agent_followups SET updated_at=unixepoch()-86401 WHERE id=?").bind(followup.id).run();
    await t.run(); const row = expect(await t.followupRead(followup.id)).followup;
    assert.equal(row.text, ""); assert.equal(row.subject, ""); assert.equal(row.from, ""); assert.equal(row.to, "");
    assert.ok(row.contentPurgedAt); assert.equal(row.messageId, followup.messageId); assert.equal(row.inReplyTo, task.messageId);
    assert.equal(expect(await t.followup(task.id, input, key)).followup.id, followup.id);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM send_recipient_charges").first("n"), 2);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_thread_sources").first("n"), 1);
    assert.equal(t.messages.length, 2);
  } finally { await t.close(); }
});
