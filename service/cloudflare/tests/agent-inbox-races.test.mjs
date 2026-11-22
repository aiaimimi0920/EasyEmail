import assert from "node:assert/strict";
import { test } from "node:test";
import { agentInboxFixture } from "./agent-inbox-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";

test("Agent receive is private, explicitly scoped, strict and Origin-bound; normal read/sync scopes grant no authority", async () => {
  const t = await agentInboxFixture();
  try {
    const bob = await t.h.register("agent-inbox-bob");
    for (const scopes of [["messages:read", "mail-accounts:sync"], ["agent-accounts:read", "agent-accounts:sync"], ["agent-inbox:read"]]) {
      const key = await newKey(t.h, t.alice.cookie, { scopes }); expect(await t.receive(undefined, 1, { token: key.token, origin: null }), 403);
    }
    expect(await t.receive(undefined, 1, { origin: null }), 403);
    expect(await t.receive(undefined, 1, { body: { expectedRevision: 1, from: "agent@example.test" } }), 400);
    expect(await t.receive("invalid-key"), 400); expect(await t.receive(undefined, "1"), 400);
    expect(await t.receive(undefined, 1, { cookie: bob.cookie }), 404);
    const key = await newKey(t.h, t.alice.cookie, { scopes: ["agent-inbox:read", "agent-accounts:sync"] });
    assert.equal(expect(await t.receive(undefined, 1, { token: key.token, origin: null })).operation.state, "committed");
    const row = expect(await t.messages()).items[0];
    expect(await t.message(row.id, { cookie: bob.cookie }), 404);
    for (const query of ["?from=x", "?limit=0", "?limit=1&limit=2", "?cursor=", "?threadId=wrong", "?association=all"]) expect(await t.messages(query), 400);
    const page = expect(await t.messages("?limit=1")); assert.equal(page.items.length, 1); assert.ok(page.nextCursor);
    assert.equal(expect(await t.messages(`?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`)).items.length, 1);
    expect(await t.messages(`?association=linked&cursor=${encodeURIComponent(page.nextCursor)}`), 400);
  } finally { await t.close(); }
});

test("concurrent original-key replay observes one claim and never opens a second IMAP connection", async () => {
  const t = await agentInboxFixture(), gate = t.holdPut(), key = crypto.randomUUID(); let pending;
  try {
    pending = t.receive(key); await gate.entered;
    const replay = expect(await t.receive(key)).operation; assert.equal(replay.state, "pending"); assert.equal(t.opens.length, 1);
    await t.h.db.prepare("UPDATE agent_inbox_requests SET created_at=unixepoch()-100 WHERE id=?").bind(replay.id).run();
    assert.equal(expect(await t.receipt(key)).operation.state, "pending");
    gate.release(); assert.equal(expect(await pending).operation.state, "committed"); pending = null;
    await t.h.restart(); assert.equal(expect(await t.receive(key)).operation.id, replay.id); assert.equal(t.opens.length, 1);
  } finally { gate.release(); if (pending) await pending; await t.close(); }
});

for (const change of ["revision", "source", "failed-request", "revoked-key"]) test(`a late Agent commit cannot survive ${change}`, async () => {
  const t = await agentInboxFixture(), gate = t.holdPut(); let pending;
  try {
    const key = crypto.randomUUID(), credential = await newKey(t.h, t.alice.cookie, { scopes: ["agent-inbox:read", "agent-accounts:sync"] });
    pending = t.receive(key, 1, { token: credential.token, origin: null }); await gate.entered;
    if (change === "revision") expect(await t.save({ displayName: "changed" }, 1));
    if (change === "source") expect(await t.save({ username: "NewAlice" }, 1));
    if (change === "failed-request") await t.h.db.prepare("UPDATE agent_inbox_requests SET state='failed',error_code='synthetic-interrupted' WHERE request_key=?").bind(key).run();
    if (change === "revoked-key") expect(await t.h.request(`/api/v1/api-keys/${credential.id}`, { method: "DELETE", cookie: t.alice.cookie }));
    gate.release(); const response = await pending; pending = null;
    assert.equal(response.status, change === "revoked-key" ? 404 : 200, response.text);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_incoming_messages").first("n"), 0);
    assert.equal(await t.h.db.prepare("SELECT after_uid FROM agent_inbox_state WHERE account_id=?").bind(t.id).first("after_uid"), 0);
    assert.notEqual(expect(await t.receipt(key)).operation.state, "committed");
  } finally { gate.release(); if (pending) await pending; await t.close(); }
});

for (const change of ["revision", "purge", "revoke-session"]) test(`late Agent content is suppressed after ${change}`, async () => {
  const t = await agentInboxFixture(), gate = t.holdPut("/get"); let pending;
  try {
    expect(await t.receive()); const row = expect(await t.messages()).items[0]; pending = t.message(row.id); await gate.entered;
    if (change === "revision") expect(await t.save({ username: "new-source" }, 1));
    if (change === "purge") await t.h.db.prepare("UPDATE agent_incoming_messages SET purged_at=unixepoch() WHERE id=?").bind(row.id).run();
    if (change === "revoke-session") await t.h.db.prepare("UPDATE sessions SET revoked_at=unixepoch() WHERE user_id=?").bind(t.alice.id).run();
    gate.release(); const response = await pending; pending = null;
    assert.equal(response.status, change === "revision" ? 409 : 404, response.text); assert.equal(response.text.includes("742951"), false);
  } finally { gate.release(); if (pending) await pending; await t.close(); }
});

test("failed original requests stay terminal and corrupt content is never returned", async () => {
  const t = await agentInboxFixture(), key = crypto.randomUUID();
  try {
    t.failPut(); const failed = expect(await t.receive(key)).operation; assert.equal(failed.state, "failed");
    t.failPut(false); assert.deepEqual(expect(await t.receive(key)).operation, failed); assert.equal(t.opens.length, 1);
    expect(await t.receive()); const row = expect(await t.messages()).items[0];
    const stored = await t.h.db.prepare("SELECT content_key FROM agent_incoming_messages WHERE id=?").bind(row.id).first();
    const bucket = await t.h.bucket("INBOX"); await bucket.put(stored.content_key, "corrupt-private-body");
    const unavailable = await t.message(row.id); expect(unavailable, 503); assert.equal(unavailable.text.includes("corrupt-private-body"), false);
  } finally { await t.close(); }
});
