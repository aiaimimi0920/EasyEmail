import assert from "node:assert/strict";
import { test } from "node:test";
import { folderReplyFixture } from "./normal-folder-reply-fixture.mjs";
import { mailInput } from "./normal-send-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";
import { selectGates } from "./account-race-fixture.mjs";

async function sourceRestore(t) {
  const tables = { normal_server_folder_state: "server_folder_id", normal_server_folder_catalogs: "account_id",
    normal_inbox_batches: "id", normal_inbox_messages: "id", sessions: "token_hash", api_keys: "id" };
  const rows = [];
  for (const [table, pk] of Object.entries(tables)) for (const row of (await t.h.db.prepare(`SELECT * FROM ${table}`).all()).results) rows.push({ table, pk, row });
  return async () => {
    await t.h.db.exec("DELETE FROM normal_message_state");
    await t.h.db.batch(rows.map(({ table, pk, row }) => {
      const columns = Object.keys(row).filter(key => key !== pk);
      return t.h.db.prepare(`UPDATE ${table} SET ${columns.map(key => `${key}=?`).join(",")} WHERE ${pk}=?`).bind(...columns.map(key => row[key]), row[pk]);
    }));
    await t.h.resetLimits();
  };
}
for (const race of ["reply-folder-epoch", "reply-folder-source", "reply-folder-generation", "reply-folder-uid", "reply-folder-wire",
  "reply-folder-catalog", "reply-folder-selectable", "reply-folder-batch", "reply-batch-source", "reply-batch-epoch", "reply-folder-owner",
  "reply-hash", "reply-content", "reply-trash", "reply-session", "reply-key"]) {
  test(`folder reply ${race} after verification cannot save, reserve SMTP or enqueue/consume a draft`, async () => {
    const t = await folderReplyFixture();
    try {
      await t.configure(); const source = await t.seedFolder(), draftId = crypto.randomUUID();
      const draft = { expectedRevision: 0, accountRevision: 1, to: mailInput.to, subject: mailInput.subject, text: mailInput.text, replyToMessageId: source.id };
      assert.equal((await t.h.request(`${t.path}/drafts/${draftId}`, { cookie: t.alice.cookie, method: "PUT", body: draft })).status, 201);
      const key = await newKey(t.h, t.alice.cookie, { scopes: ["mail-accounts:read", "messages:read", "mail-accounts:send", "mail-accounts:schedule", "drafts:write"] });
      const restore = await sourceRestore(t), body = { ...mailInput, replyToMessageId: source.id, draftId, draftRevision: 1 };
      for (const action of ["save", "send", "enqueue"]) {
        const extra = { cookie: race === "reply-key" ? null : t.alice.cookie, ...(race === "reply-key" ? { token: key.token } : {}),
          headers: { "idempotency-key": crypto.randomUUID(), "x-test-smtp-race": race } };
        const result = action === "save" ? await t.h.request(`${t.path}/drafts/${crypto.randomUUID()}`, { method: "PUT", body: draft, ...extra })
          : action === "send" ? await t.send(body, crypto.randomUUID(), extra) : await t.enqueue(body, crypto.randomUUID(), extra);
        assert.ok(result.status >= 400, `${race}/${action}: ${result.text}`); assert.equal(t.opens.length, 0);
        assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_outgoing_messages").first("n"), 0);
        assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_send_jobs").first("n"), 0);
        assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM drafts").first("n"), 1);
        assert.equal(await t.h.db.prepare("SELECT state FROM drafts WHERE id=?").bind(draftId).first("state"), "editing");
        await restore();
      }
    } finally { await t.close(); }
  });
}

for (const mutation of ["stale-claim", "folder-generation", "catalog"]) {
  test(`folder queued reply checks ${mutation} at its final reservation, not the revoked creator credential`, async () => {
    const t = await folderReplyFixture(), gates = await selectGates(), gate = gates.hold("reservation", "unused"); let tick;
    try {
      await t.configure(); const source = await t.seedFolder(), queued = await t.enqueue({ ...mailInput, replyToMessageId: source.id });
      assert.equal(queued.status, 201, queued.text);
      await t.h.restart({ TEST_QUEUE_GATE: `${gates.bindings.TEST_SELECT_GATE}/reservation` }); tick = t.tick(); await gate.entered();
      if (mutation === "stale-claim") await t.h.db.prepare("UPDATE normal_send_jobs SET claim_token=? WHERE id=?").bind(crypto.randomUUID(), queued.body.job.id).run();
      if (mutation === "folder-generation") await t.h.db.prepare("UPDATE normal_server_folder_state SET cache_generation=cache_generation+1 WHERE account_id=?").bind(t.id).run();
      if (mutation === "catalog") await t.h.db.prepare("UPDATE normal_server_folder_catalogs SET folders='[]' WHERE account_id=?").bind(t.id).run();
      gate.release(); await tick; tick = null; assert.equal(t.opens.length, 0);
      assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_outgoing_messages").first("n"), 0);
    } finally { gate.release(); if (tick) await tick; await t.close(); await gates.close(); }
  });
}
