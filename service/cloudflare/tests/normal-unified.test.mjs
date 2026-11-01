import assert from "node:assert/strict";
import { test } from "node:test";
import { normalAccessFixture } from "./normal-access-fixture.mjs";
import { newKey, seedMailbox } from "./runtime-harness.mjs";

const unified = (t, params = {}, extra = {}) => t.h.request(`/api/v1/messages?${new URLSearchParams({ sources: "all", ...params })}`, { cookie: t.alice.cookie, ...extra });
async function temporary(t, id, time) {
  const box = await seedMailbox(t.h, t.alice.id, "temporary@example.test");
  await t.h.db.prepare(`INSERT INTO messages(id,user_id,mailbox_id,remote_id,fingerprint,sender,recipient,subject,text_body,html_body,attachments,received_at,observed_at)
    VALUES (?,?,?,?,?,'sender@example.test','temporary@example.test','temporary message','验证码 351927','','[]',?,?)`)
    .bind(id, t.alice.id, box, id, id, time, time).run();
  return box;
}

test("unified timeline preserves source identities, same-time/same-id pages and searches normal cached bodies without reconnecting", async () => {
  const t = await normalAccessFixture();
  try {
    assert.equal((await t.receive()).body.request.state, "committed");
    const normal = (await t.messages()).body.items[0]; await temporary(t, normal.id, normal.receivedAt);
    const first = await unified(t, { limit: "1" }); assert.equal(first.status, 200, first.text);
    assert.equal(first.body.items[0].sourceKind, "temporary");
    const items = [...first.body.items]; let cursor = first.body.nextCursor;
    while (cursor) { const page = await unified(t, { limit: "1", cursor }); assert.equal(page.status, 200, page.text); items.push(...page.body.items); cursor = page.body.nextCursor; }
    assert.equal(items.length, 3); assert.equal(new Set(items.map(row => `${row.sourceKind}:${row.id}`)).size, 3);
    const found = await unified(t, { q: "742951" }); assert.equal(found.body.items.length, 2);
    assert.ok(found.body.items.every(row => row.sourceKind === "normal" && row.accountId === t.id && row.isRead === undefined));
    assert.equal((await unified(t, { q: "351927" })).body.items[0].sourceKind, "temporary");
    assert.equal((await unified(t, { sources: "normal", accountId: t.id, sender: "SENDER@", recipient: "ALICE@" })).body.items.length, 2);
    assert.equal((await unified(t, { sources: "temporary" })).body.items.length, 1);
    assert.equal((await t.h.request("/api/v1/messages", { cookie: t.alice.cookie })).body.items.length, 1, "legacy endpoint never gains ordinary access");
    assert.equal(t.opens.length, 1); assert.equal(JSON.stringify(found.body).includes("normal-inbox/v1/"), false);
  } finally { await t.close(); }
});

test("unified ordinary access needs both scopes, owner, current source and explicit supported filters", async () => {
  const t = await normalAccessFixture();
  try {
    await t.receive(); const initial = await unified(t, { limit: "1" }); assert.ok(initial.body.nextCursor);
    for (const scopes of [["messages:read"], ["mail-accounts:read"], ["mail-accounts:sync"]]) {
      const key = await newKey(t.h, t.alice.cookie, { scopes }); assert.equal((await unified(t, {}, { token: key.token, cookie: undefined })).status, 403);
    }
    const reader = await newKey(t.h, t.alice.cookie, { scopes: ["messages:read", "mail-accounts:read"] });
    assert.equal((await unified(t, {}, { token: reader.token, cookie: undefined })).status, 200);
    const bob = await t.h.register("unified-private-bob");
    assert.equal((await unified(t, {}, { cookie: bob.cookie })).body.items.length, 0);
    assert.equal((await unified(t, { sources: "normal", accountId: t.id }, { cookie: bob.cookie })).status, 404);
    for (const params of [{ sources: "bad" }, { accountId: "invalid" }, { labelId: "invalid" }, { sources: "normal", providerId: "fixture" }]) {
      assert.equal((await unified(t, params)).status, 400, JSON.stringify(params));
    }
    assert.equal((await t.save({ enabled: false }, 1)).status, 200); assert.equal((await unified(t)).body.items.length, 2);
    assert.equal((await unified(t, { limit: "1", cursor: initial.body.nextCursor })).status, 400);
    assert.equal((await t.save({ username: "changed-source", enabled: true }, 2)).status, 200);
    assert.equal((await unified(t)).body.items.length, 0);
  } finally { await t.close(); }
});

test("ordinary cached extraction shares the real OTP matcher and strict freshness without opening IMAP", async () => {
  const t = await normalAccessFixture();
  try {
    await t.receive(); const time = (await t.messages()).body.items[0].receivedAt;
    const query = (params = {}, extra = {}) => t.h.request(`${t.base}/extractions?${new URLSearchParams({ since: String(time), ...params })}`, { cookie: t.alice.cookie, ...extra });
    const result = await query({ kind: "otp", sender: "sender@" }); assert.equal(result.status, 200, result.text);
    assert.equal(result.body.items.length, 2); assert.equal(result.body.items[0].otp.code, "742951");
    assert.equal((await query({ since: String(time + 1) })).body.items.length, 0);
    assert.equal((await query({ recipient: "other@example.test" })).status, 400);
    const old = await newKey(t.h, t.alice.cookie, { scopes: ["messages:read"] });
    assert.equal((await query({}, { token: old.token, cookie: undefined })).status, 403);
    assert.equal(t.opens.length, 1); assert.equal(result.body.sync.cachedOnly, true);
  } finally { await t.close(); }
});
