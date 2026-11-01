import assert from "node:assert/strict";
import { test } from "node:test";
import { mixedFixture, openMixed, button, completed, captureWrites, assertPlatformOnly } from "./mixed-organization-fixture.mjs";
import { PASSWORD } from "./runtime-harness.mjs";

const result = page => page.getByRole("region", { name: "批量整理结果", exact: true });
const group = (page, name) => result(page).getByRole("listitem").filter({ hasText: name });
test("Chrome: partial commit survives navigation, 403 retry and 404 read; GET reconciliation does not replay or auto-run later accounts", { timeout: 120000 }, async () => {
  const t = await mixedFixture(); let browser, page;
  try {
    let inbox; ({ browser, page, inbox } = await openMixed(t)); const writes = captureWrites(page), account = t.accounts[0], name = `普通邮箱 ${t.addresses[account]}`;
    let first = true, missing = true, reads = 0;
    await page.route(`**/api/v1/normal-accounts/${account}/messages/organize`, async route => {
      if (first) { first = false; const response = await route.fetch(); assert.equal(response.status(), 200); await response.dispose();
        return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "normal_organization_storage_failed" } }) }); }
      await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { code: "forbidden" } }) });
    });
    await page.route(`**/api/v1/normal-accounts/${account}/organization-operations/*`, async route => {
      reads++; if (missing) { missing = false; return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "not_found" } }) }); }
      await route.continue();
    });
    await button(inbox, "选择当前页邮件").click(); await button(inbox, "批量标为已读").click();
    await result(page).getByRole("status").filter({ hasText: "未确认 1 组；未执行 1 组" }).waitFor();
    assert.equal(writes.length, 2); const original = writes[1];
    const later = await t.h.request(`/api/v1/normal-accounts/${account}/messages/organize`, { method: "POST", cookie: t.alice.cookie,
      headers: { "idempotency-key": crypto.randomUUID() }, body: { messageIds: original.body.messageIds, isRead: false } }); assert.equal(later.status, 200);
    await page.getByRole("navigation").getByRole("button", { name: "普通邮箱", exact: true }).click();
    const normal = page.getByRole("region", { name: "普通邮箱", exact: true }); await button(normal, "普通邮箱").waitFor();
    assert.equal(await button(normal, "普通邮箱").isDisabled(), true);
    await button(page, `原键重试 ${name}`).click(); await group(page, name).getByRole("alert").filter({ hasText: "forbidden" }).waitFor();
    assert.equal(writes.length, 3); assert.deepEqual(writes[1], writes[2]);
    assert.equal(await button(page, "继续未执行组").isDisabled(), true);
    await button(page, `只读核对 ${name}`).click(); await group(page, name).getByRole("alert").filter({ hasText: "请求失败：not_found" }).waitFor();
    assert.equal(reads, 1); assert.equal(await button(normal, "普通邮箱").isDisabled(), true);
    await button(page, `只读核对 ${name}`).click(); await group(page, name).getByText(/已完成/).waitFor();
    assert.equal(reads, 2); assert.equal(writes.length, 3); assert.equal(await button(page, "继续未执行组").isEnabled(), true);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_message_state WHERE message_id IN (SELECT value FROM json_each(?)) AND is_read=1")
      .bind(JSON.stringify(original.body.messageIds)).first("n"), 0);
    await button(page, "继续未执行组").click(); await completed(page, 5); assert.equal(writes.length, 4);
    assert.equal(writes[3].path, `/api/v1/normal-accounts/${t.accounts[1]}/messages/organize`);
    assert.equal(await button(normal, "普通邮箱").isEnabled(), true); await assertPlatformOnly(t, page);
  } finally { await browser?.close(); await t.close(); }
});

for (const kind of ["normal", "temporary"]) test(`Chrome: ${kind} original-key controller keeps an earlier unknown commit after a denied retry`, { timeout: 90000 }, async () => {
  const t = await mixedFixture(); let browser, page;
  try {
    let inbox; ({ browser, page, inbox } = await openMixed(t)); const writes = captureWrites(page); let mode = "lose";
    await page.route(kind === "normal" ? "**/api/v1/normal-accounts/*/messages/organize" : "**/api/v1/messages/organize", async route => {
      if (mode === "deny") return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { code: "forbidden" } }) });
      const response = await route.fetch(); if (mode === "lose") { mode = "deny"; await response.dispose(); return route.abort("connectionfailed"); }
      await route.fulfill({ response });
    });
    if (kind === "normal") { await button(inbox, "收件验收").first().click(); await button(inbox, "加星标").click(); }
    else { await inbox.getByLabel("选择邮件 临时批量邮件", { exact: true }).check(); await button(inbox, "批量加星标").click(); }
    const retry = kind === "normal" ? "重试原普通整理" : "核对并完成原整理";
    await button(page, retry).waitFor(); assert.equal(writes.length, 1);
    const original = writes[0]; await button(page, retry).click(); await page.getByRole("alert").filter({ hasText: "forbidden" }).waitFor();
    assert.equal(await button(page, retry).count(), 1, "a denied retry cannot discard an earlier unknown request");
    assert.equal(await button(inbox, "选择当前页邮件").isDisabled(), true);
    const edit = await t.h.request(original.path, { method: "POST", cookie: t.alice.cookie, headers: { "idempotency-key": crypto.randomUUID() },
      body: { messageIds: original.body.messageIds, starred: false } }); assert.equal(edit.status, 200);
    mode = "pass"; await button(page, retry).click(); await page.getByRole("status").filter({ hasText: "已核对原操作" }).waitFor();
    assert.equal(writes.length, 3); assert.deepEqual(writes[0], writes[1]); assert.deepEqual(writes[0], writes[2]);
    const table = kind === "normal" ? "normal_message_state" : "messages", field = kind === "normal" ? "message_id" : "id";
    assert.equal(await t.h.db.prepare(`SELECT starred FROM ${table} WHERE ${field}=?`).bind(original.body.messageIds[0]).first("starred"), 0);
    await assertPlatformOnly(t, page);
  } finally { await browser?.close(); await t.close(); }
});

test("Chrome: cancelling never-executed accounts retains an unknown temporary key; exact retry cannot overwrite later edits", { timeout: 90000 }, async () => {
  const t = await mixedFixture(); let browser, page;
  try {
    let inbox; ({ browser, page, inbox } = await openMixed(t)); const writes = captureWrites(page); let first = true;
    await page.route("**/api/v1/messages/organize", async route => {
      const response = await route.fetch(); if (first) { first = false; await response.dispose(); return route.abort("connectionfailed"); }
      await route.fulfill({ response });
    });
    await button(inbox, "选择当前页邮件").click(); await button(inbox, "批量标为已读").click();
    await result(page).getByRole("status").filter({ hasText: "未确认 1 组；未执行 2 组" }).waitFor();
    const key = writes[0].key; await button(page, "取消未执行组").click();
    await result(page).getByRole("status").filter({ hasText: "未确认 1 组；未执行 0 组；已取消 2 组" }).waitFor();
    assert.equal(await button(inbox, "搜索邮件").isDisabled(), true); assert.ok((await group(page, "临时邮箱").textContent()).includes(key));
    const edit = await t.h.request("/api/v1/messages/organize", { method: "POST", cookie: t.alice.cookie,
      headers: { "idempotency-key": crypto.randomUUID() }, body: { messageIds: [t.collisionId], isRead: false } }); assert.equal(edit.status, 200);
    await button(page, "原键重试 临时邮箱").click(); await completed(page, 1);
    assert.equal(writes.length, 2); assert.deepEqual(writes[0], writes[1]);
    assert.equal(await t.h.db.prepare("SELECT is_read FROM messages WHERE id=?").bind(t.collisionId).first("is_read"), 0);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_message_state").first("n"), 0);
    assert.equal(await button(inbox, "搜索邮件").isEnabled(), true); await assertPlatformOnly(t, page);
  } finally { await browser?.close(); await t.close(); }
});

test("Chrome: a definite account rejection is isolated; later groups require explicit continuation and successful groups are never resent", { timeout: 90000 }, async () => {
  const t = await mixedFixture(); let browser, page;
  try {
    let inbox; ({ browser, page, inbox } = await openMixed(t)); const writes = captureWrites(page), account = t.accounts[0];
    await page.route(`**/api/v1/normal-accounts/${account}/messages/organize`, route => route.fulfill({ status: 409, contentType: "application/json",
      body: JSON.stringify({ error: { code: "normal_organization_changed_or_limit" } }) }));
    await button(inbox, "选择当前页邮件").click(); await button(inbox, "批量加星标").click();
    await result(page).getByRole("status").filter({ hasText: "拒绝 1 组；未确认 0 组；未执行 1 组" }).waitFor();
    assert.equal(writes.length, 2); assert.equal(await button(inbox, "搜索邮件").isDisabled(), true);
    await button(page, "继续未执行组").click(); await completed(page, 3); assert.equal(writes.length, 3);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_message_state WHERE starred=1").first("n"), 2);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM messages WHERE starred=1").first("n"), 1);
    assert.equal(await button(inbox, "搜索邮件").isEnabled(), true); await assertPlatformOnly(t, page);
  } finally { await browser?.close(); await t.close(); }
});

test("Chrome: logout discards the old user's batch controller and a late reply cannot dispatch later groups into another user", { timeout: 90000 }, async () => {
  const t = await mixedFixture(); let browser, page, release;
  try {
    const bob = await t.h.register(`batch-${crypto.randomUUID().slice(0, 8)}`);
    let inbox; ({ browser, page, inbox } = await openMixed(t)); const writes = captureWrites(page);
    let enter; const entered = new Promise(resolve => { enter = resolve; }), wait = new Promise(resolve => { release = resolve; });
    await page.route("**/api/v1/messages/organize", async route => {
      const response = await route.fetch(); assert.equal(response.status(), 200); enter(); await wait; await route.fulfill({ response });
    });
    await button(inbox, "选择当前页邮件").click(); await button(inbox, "批量标为已读").click(); await entered;
    await button(page, "退出登录").click(); await page.getByLabel("用户名", { exact: true }).waitFor();
    await page.getByLabel("用户名", { exact: true }).fill(bob.username);
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await button(page, "登录").click();
    await button(page, "退出登录").waitFor();
    const replied = page.waitForResponse(response => /\/api\/v1\/messages\/organize$/.test(response.url())); release(); await replied;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(writes.length, 1); assert.equal(await result(page).count(), 0);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_organization_operations").first("n"), 0);
    await page.getByRole("navigation").getByRole("button", { name: "聚合收件箱", exact: true }).click();
    await page.getByRole("region", { name: "聚合邮件", exact: true }).getByRole("status").filter({ hasText: "已加载 0 封" }).waitFor();
    await assertPlatformOnly(t, page);
  } finally { release?.(); await browser?.close(); await t.close(); }
});
