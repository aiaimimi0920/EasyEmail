import assert from "node:assert/strict";
import { test } from "node:test";
import { agentInboxFixture } from "./agent-inbox-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";

test("Agent inbox reads the real IMAP/MIME path into an independent private epoch and reconciles the original sync without reconnecting", async () => {
  const t = await agentInboxFixture();
  try {
    const key = crypto.randomUUID(), received = expect(await t.receive(key)).operation;
    assert.equal(received.state, "committed"); assert.equal(received.result.stored, 2);
    assert.equal(t.opens.length, 1); assert.equal(expect(await t.receive(key)).operation.id, received.id); assert.equal(t.opens.length, 1);
    const page = expect(await t.messages()); assert.equal(page.items.length, 2);
    const message = expect(await t.message(page.items[0].id)).message;
    assert.ok(message.content.textBody.includes("742951")); assert.equal(message.association, "unknown_service");
    assert.equal(message.authentication, "unverified");
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_messages").first("n"), 0);
    const keys = (await (await t.h.bucket("INBOX")).list()).objects.map(row => row.key); assert.ok(keys.length === 4 && keys.every(key => key.startsWith("agent-inbox/v1/")));
    await t.h.restart(); assert.equal(expect(await t.receipt(key)).operation.state, "committed");
    expect(await t.receive(key, 2), 409); expect(await t.receive(), 200); assert.equal(expect(await t.messages()).items.length, 2);
    t.scenario({ validity: "43" }); const reset = expect(await t.receive()).operation;
    assert.equal(reset.result.reset, true); assert.equal(expect(await t.messages()).items.length, 2);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_incoming_messages").first("n"), 4);
    expect(await t.message(page.items[0].id), 404);
  } finally { await t.close(); }
});
