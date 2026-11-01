import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness, seedMailbox, newKey } from "./runtime-harness.mjs";
import { draftFixture, draftBody, saveDraft, deleteDraft, ok } from "./draft-fixture.mjs";

test("the draft limit is checked atomically, tombstones do not consume content slots and failed saves preserve old content", async () => {
  const f = await draftFixture(), { h, alice, box } = f;
  try {
    await h.db.batch(Array.from({ length: 99 }, () => h.db.prepare(`INSERT INTO drafts(user_id,id,revision,content_hash,created_at,updated_at)
      VALUES (?,?,1,'synthetic',unixepoch(),unixepoch())`).bind(alice.id, crypto.randomUUID())));
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    const replies = await Promise.all(ids.map(id => saveDraft(h, alice.cookie, id, draftBody(box))));
    assert.deepEqual(replies.map(r => r.status).sort(), [201, 409]);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM drafts WHERE state!='deleted'").first("n"), 100);
    const winner = ids[replies.findIndex(r => r.status === 201)];
    await h.db.prepare("CREATE TRIGGER fail_draft_update BEFORE UPDATE ON drafts BEGIN SELECT RAISE(ABORT,'synthetic draft failure'); END").run();
    try { assert.equal((await saveDraft(h, alice.cookie, winner, draftBody(box, { expectedRevision: 1, text: "must not persist" }))).status, 500); }
    finally { await h.db.prepare("DROP TRIGGER fail_draft_update").run(); }
    assert.equal(await h.db.prepare("SELECT text_body FROM drafts WHERE id=?").bind(winner).first("text_body"), draftBody().text);
    ok(await deleteDraft(h, alice.cookie, winner, 1));
    ok(await saveDraft(h, alice.cookie, crypto.randomUUID(), draftBody()), 201);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM drafts WHERE state!='deleted'").first("n"), 100);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM drafts WHERE state='deleted'").first("n"), 1);
  } finally { await f.close(); }
});

test("0014 expand preserves every existing application row and does not grant old keys new scopes", async () => {
  const h = await createHarness({}, false, "0013_account_management.sql");
  try {
    const user = await h.register("draft-upgrade-user"), box = await seedMailbox(h, user.id, "keep@example.test");
    const key = await newKey(h, user.cookie, { scopes: ["mailboxes:read", "messages:read", "messages:send"] });
    await h.db.prepare("UPDATE mailboxes SET credential_cipher='opaque-secret-cipher',note='保留备注' WHERE id=?").bind(box).run();
    const tables = (await h.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).results.map(r => r.name)
      .filter(name => !name.startsWith("_") && !name.startsWith("sqlite_"));
    const before = {};
    for (const table of tables) before[table] = (await h.db.prepare(`SELECT * FROM ${table}`).all()).results;
    await h.migrate(); await h.migrate(); await h.restart();
    for (const table of tables) assert.deepEqual((await h.db.prepare(`SELECT * FROM ${table}`).all()).results, before[table], table);
    assert.equal((await h.request("/api/v1/drafts", { token: key.token })).status, 403);
    assert.equal((await h.request(`/api/v1/mailboxes/${box}`, { token: key.token })).body.mailbox.note, "保留备注");
    ok(await saveDraft(h, user.cookie, crypto.randomUUID(), draftBody(box)), 201);
  } finally { await h.close(); }
});
