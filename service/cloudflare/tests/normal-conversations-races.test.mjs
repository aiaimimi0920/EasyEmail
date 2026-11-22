import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { normalConversationFixture, expect } from "./normal-conversations-fixture.mjs";

async function unindex(t) {
  await t.h.db.prepare("DELETE FROM normal_thread_links").run();
  await t.h.db.prepare("UPDATE normal_inbox_messages SET thread_key=NULL,thread_basis=NULL,thread_version=0,thread_limited=0").run();
  await t.h.db.prepare("DELETE FROM normal_inbox_search").run();
}
test("graph failure rolls back receipt commit, message/search/links and source checkpoint as one D1 batch", async () => {
  const t = await normalConversationFixture();
  try {
    await t.h.db.prepare("CREATE TRIGGER test_normal_graph_failure BEFORE UPDATE OF thread_version ON normal_inbox_messages BEGIN SELECT RAISE(ABORT,'synthetic graph failure'); END").run();
    assert.equal((await t.receive()).body.request.state, "failed");
    for (const table of ["normal_inbox_messages", "normal_inbox_search", "normal_thread_links"]) assert.equal(await t.h.db.prepare(`SELECT COUNT(*) n FROM ${table}`).first("n"), 0);
    assert.equal((await t.state()).version, 0); assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_batches WHERE status='committed'").first("n"), 0);
    await t.h.db.prepare("DROP TRIGGER test_normal_graph_failure").run(); await t.receiveAll(); assert.equal(expect(await t.list()).items.length, 2);
    await unindex(t);
    await t.h.db.prepare("CREATE TRIGGER test_normal_repair_failure BEFORE UPDATE OF thread_version ON normal_inbox_messages BEGIN SELECT RAISE(ABORT,'synthetic repair failure'); END").run();
    expect(await t.list(), 500);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_thread_links").first("n"), 0);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_search").first("n"), 0);
    await t.h.db.prepare("DROP TRIGGER test_normal_repair_failure").run(); assert.equal(expect(await t.list()).items.length, 2);
  } finally { await t.close(); }
});

for (const change of ["revision", "source", "delete", "user", "epoch"]) test(`late ordinary graph repair cannot write or disclose after ${change} change`, async () => {
  const t = await normalConversationFixture(); let gate, pending;
  try {
    await t.receiveAll(); const oldEpoch = (await t.state()).epoch_id;
    await unindex(t); gate = t.holdPut("/get"); pending = t.list(); await gate.entered;
    if (change === "revision") expect(await t.save({ displayName: "Updated" }, 1));
    if (change === "source") expect(await t.save({ username: "new-source" }, 1));
    if (change === "delete") expect(await t.h.request(t.base, { method: "DELETE", cookie: t.alice.cookie,
      headers: { "idempotency-key": crypto.randomUUID() }, body: { expectedRevision: 1 } }));
    if (change === "user") await t.h.db.prepare("UPDATE users SET status='disabled' WHERE id=?").bind(t.alice.id).run();
    if (change === "epoch") { t.scenario({ validity: "43", messages: t.messages, uidNext: 4 }); await t.receiveAll(); }
    gate.release(); const result = await pending; pending = null;
    assert.ok([401, 404, 409].includes(result.status), result.text); assert.equal(result.text.includes("Needle"), false);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_thread_links WHERE epoch_id=?").bind(oldEpoch).first("n"), 0);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_search p JOIN normal_inbox_messages m ON m.id=p.message_id WHERE m.epoch_id=?").bind(oldEpoch).first("n"), 0);
    assert.equal(t.opens.length, change === "epoch" ? 2 : 1);
  } finally { gate?.release(); if (pending) await pending; await t.close(); }
});

test("legacy missing normalized headers is compatible, malformed normalized header shapes fail closed despite valid object digests", async () => {
  const t = await normalConversationFixture();
  try {
    await t.receiveAll(); const row = await t.h.db.prepare("SELECT * FROM normal_inbox_messages ORDER BY id LIMIT 1").first(), bucket = await t.h.bucket("INBOX");
    const original = JSON.parse(await (await bucket.get(row.content_key)).text());
    async function replace(content) {
      await unindex(t); const bytes = Buffer.from(JSON.stringify(content)), digest = createHash("sha256").update(bytes).digest("hex");
      await bucket.put(row.content_key, bytes); await t.h.db.prepare("UPDATE normal_inbox_messages SET content_sha256=?,content_bytes=? WHERE id=?").bind(digest, bytes.length, row.id).run();
    }
    for (const threadHeaders of [{ references: "not-array", inReplyTo: [], limited: false }, { references: [42], inReplyTo: [], limited: false },
      { references: [], inReplyTo: [], limited: "false" }, { references: Array(28).fill("<x@example.test>"), inReplyTo: [], limited: false }]) {
      await replace({ ...original, threadHeaders }); expect(await t.list(), 503);
      assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_thread_links").first("n"), 0);
    }
    const legacy = { ...original }; delete legacy.threadHeaders; await replace(legacy); expect(await t.list());
    assert.equal(await t.h.db.prepare("SELECT thread_version FROM normal_inbox_messages WHERE id=?").bind(row.id).first("thread_version"), 1);
    assert.equal(t.opens.length, 1);
  } finally { await t.close(); }
});
