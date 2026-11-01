import assert from "node:assert/strict";
import { test } from "node:test";
import { agentInboxFixture } from "./agent-inbox-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";
import { multipartMessage, ATTACHMENT } from "./normal-mime-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";

for (const fault of ["insert-ack", "commit-ack"]) test(`Agent receive reconciles ${fault} without a new connection or duplicate messages`, async () => {
  const t = await agentInboxFixture({ bindings: { TEST_AGENT_INBOX_FAULT: fault } });
  try {
    const key = crypto.randomUUID(), result = expect(await t.receive(key)).operation;
    assert.equal(result.state, fault === "insert-ack" ? "pending" : "committed");
    const connections = fault === "insert-ack" ? 0 : 1; assert.equal(t.opens.length, connections);
    await t.h.restart({ TEST_AGENT_INBOX_FAULT: "" }); assert.equal(expect(await t.receive(key)).operation.id, result.id); assert.equal(t.opens.length, connections);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_incoming_messages").first("n"), fault === "insert-ack" ? 0 : 2);
    if (fault === "insert-ack") {
      await t.h.db.prepare("UPDATE agent_inbox_requests SET created_at=unixepoch()-100 WHERE id=?").bind(result.id).run();
      await t.h.db.prepare(`INSERT INTO agent_inbox_state(account_id,user_id,claim_token,claim_revision,request_id,claim_lease_until)
        VALUES(?,?,?,1,?,unixepoch()-10)`).bind(t.id, t.alice.id, crypto.randomUUID(), result.id).run();
      assert.equal(expect(await t.receive(key)).operation.state, "failed"); assert.equal(t.opens.length, 0);
      assert.equal(expect(await t.receipt(key)).operation.state, "failed"); assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_inbox_batches").first("n"), 0);
    }
  } finally { await t.close(); }
});

test("an incoming INSERT failure rolls back batch visibility, request completion and cursor together", async () => {
  const t = await agentInboxFixture();
  try {
    await t.h.db.prepare("CREATE TRIGGER reject_agent_receive BEFORE INSERT ON agent_incoming_messages BEGIN SELECT RAISE(ABORT,'synthetic-agent-receive'); END").run();
    const key = crypto.randomUUID(), failed = expect(await t.receive(key)).operation; assert.equal(failed.state, "failed");
    assert.equal(await t.h.db.prepare("SELECT state FROM agent_inbox_batches").first("state"), "staged");
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_incoming_messages").first("n"), 0);
    assert.equal(await t.h.db.prepare("SELECT after_uid FROM agent_inbox_state").first("after_uid"), 0);
    await t.h.db.prepare("DROP TRIGGER reject_agent_receive").run(); expect(await t.receive(key)); assert.equal(t.opens.length, 1);
    assert.equal(expect(await t.receive()).operation.state, "committed");
  } finally { await t.close(); }
});

test("Agent raw and attachment downloads need independent authority and verify actual bytes", async () => {
  const raw = multipartMessage(), t = await agentInboxFixture({ messages: new Map([[1, raw]]), uidNext: 2 });
  try {
    expect(await t.receive()); const id = expect(await t.messages()).items[0].id;
    async function download(suffix, token) {
      const response = await fetch(new URL(`${t.base}/messages/${id}/${suffix}`, t.h.baseUrl), { headers: token ? { authorization: `Bearer ${token}` } : { cookie: t.alice.cookie } });
      return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
    }
    const key = await newKey(t.h, t.alice.cookie, { scopes: ["agent-inbox:read"] }); assert.equal((await download("raw", key.token)).status, 403);
    const rawResult = await download("raw"), attachment = await download("attachments/0");
    assert.equal(rawResult.status, 200); assert.deepEqual(rawResult.bytes, raw); assert.equal(attachment.status, 200); assert.deepEqual(attachment.bytes, ATTACHMENT);
    const row = await t.h.db.prepare("SELECT raw_key FROM agent_incoming_messages WHERE id=?").bind(id).first(); await (await t.h.bucket("INBOX")).put(row.raw_key, "private-tampered");
    assert.equal((await download("raw")).status, 503); assert.equal((await download("attachments/0")).status, 503);
  } finally { await t.close(); }
});
