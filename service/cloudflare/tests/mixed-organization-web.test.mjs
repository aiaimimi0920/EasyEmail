import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { mixedFixture, openMixed, button, combo, completed, captureWrites, assertPlatformOnly } from "./mixed-organization-fixture.mjs";

test("Chrome: source-qualified selection batches temporary and two ordinary accounts with shared labels, placement and reversible trash", { timeout: 120000 }, async () => {
  const t = await mixedFixture(); let browser, page;
  try {
    let inbox; ({ browser, page, inbox } = await openMixed(t)); const writes = captureWrites(page), errors = [], external = [];
    page.on("pageerror", failure => errors.push(failure.message));
    page.on("request", request => { if (!request.url().startsWith(t.h.baseUrl.origin)) external.push(request.url()); });
    assert.equal(await inbox.getByRole("checkbox").count(), 5);
    await button(inbox, "选择当前页邮件").click(); await inbox.getByRole("status").filter({ hasText: "已选择 5 封" }).waitFor();
    await button(inbox, "批量标为已读").click(); await completed(page, 5);
    assert.equal(writes.length, 3); assert.deepEqual(writes.map(row => row.body.messageIds.length), [1, 2, 2]);
    assert.equal(writes[0].path, "/api/v1/messages/organize");
    assert.deepEqual(writes.slice(1).map(row => row.path), t.accounts.map(id => `/api/v1/normal-accounts/${id}/messages/organize`));
    assert.equal(new Set(writes.map(row => row.key)).size, 3);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM messages WHERE is_read=1").first("n"), 1);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_message_state WHERE is_read=1").first("n"), 4);
    await inbox.getByRole("status").filter({ hasText: "已选择 0 封" }).waitFor();
    await button(inbox, "选择当前页邮件").click(); await combo(inbox, "批量标签").selectOption(t.label);
    await button(inbox, "批量添加标签").click(); await completed(page, 5);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM message_labels").first("n"), 1);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_message_labels").first("n"), 4);
    await button(inbox, "选择当前页邮件").click(); await combo(inbox, "批量目标文件夹").selectOption(t.folder);
    await button(inbox, "批量移动位置").click(); await inbox.getByRole("status").filter({ hasText: "已加载 0 封" }).waitFor();
    await combo(inbox, "自定义文件夹筛选").selectOption(t.folder); await button(inbox, "搜索邮件").click();
    await inbox.getByRole("status").filter({ hasText: "已加载 5 封" }).waitFor(); await button(inbox, "选择当前页邮件").click();
    const before = writes.length; page.once("dialog", dialog => dialog.dismiss()); await button(inbox, "批量移到平台回收站").click();
    assert.equal(writes.length, before); page.once("dialog", dialog => dialog.accept()); await button(inbox, "批量移到平台回收站").click();
    await inbox.getByRole("status").filter({ hasText: "已加载 0 封" }).waitFor();
    await combo(inbox, "文件夹").selectOption("trash"); await button(inbox, "搜索邮件").click();
    await inbox.getByRole("status").filter({ hasText: "已加载 5 封" }).waitFor(); await button(inbox, "选择当前页邮件").click();
    await button(inbox, "批量恢复平台邮件").click(); await inbox.getByRole("status").filter({ hasText: "已加载 0 封" }).waitFor();
    await combo(inbox, "文件夹").selectOption("inbox"); await button(inbox, "搜索邮件").click();
    await inbox.getByRole("status").filter({ hasText: "已加载 5 封" }).waitFor();
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_message_folders WHERE folder_id=?").bind(t.folder).first("n"), 4);
    await assertPlatformOnly(t, page); assert.deepEqual(errors, []); assert.deepEqual(external, []);
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(t.h.directory, "mixed-organization-mobile.png"), fullPage: true });
    console.log(`Mixed organization browser evidence: ${t.h.directory}`);
  } catch (failure) { if (page) await page.screenshot({ path: path.join(t.h.directory, "mixed-organization-failure.png"), fullPage: true }); throw failure; }
  finally { await browser?.close(); await t.close(); }
});

test("Chrome: mixed identities remain bounded across pages and selecting the latest page replaces rather than accumulates", { timeout: 90000 }, async () => {
  const t = await mixedFixture(); let browser, page;
  try {
    const now = Math.floor(Date.now() / 1000);
    await t.h.db.batch(Array.from({ length: 46 }, (_, index) => {
      const id = crypto.randomUUID();
      return t.h.db.prepare(`INSERT INTO messages(id,user_id,mailbox_id,remote_id,fingerprint,sender,recipient,subject,text_body,html_body,attachments,received_at,observed_at)
        VALUES (?,?,?,?,?,'sender@example.test','temporary@example.test',?,'','','[]',?,?)`)
        .bind(id, t.alice.id, t.box, id, id, `分页邮件 ${index}`, now - index, now);
    }));
    let inbox; ({ browser, page, inbox } = await openMixed(t, 25));
    await button(inbox, "选择当前页邮件").click(); await inbox.getByRole("status").filter({ hasText: "已选择 25 封" }).waitFor();
    await button(inbox, "加载更多聚合邮件").click(); await inbox.getByRole("status").filter({ hasText: "已加载 50 封" }).waitFor();
    for (const checkbox of await inbox.getByRole("checkbox").all()) if (!await checkbox.isChecked()) await checkbox.check();
    await inbox.getByRole("status").filter({ hasText: "已选择 50 封" }).waitFor();
    await button(inbox, "加载更多聚合邮件").click(); await inbox.getByRole("status").filter({ hasText: "已加载 51 封" }).waitFor();
    assert.equal(await inbox.getByRole("checkbox", { checked: false }).count(), 1);
    assert.equal(await inbox.getByRole("checkbox", { checked: false }).isDisabled(), true);
    await button(inbox, "选择当前页邮件").click(); await inbox.getByRole("status").filter({ hasText: "已选择 1 封" }).waitFor();
    await combo(inbox, "邮件来源").selectOption("normal"); await button(inbox, "搜索邮件").click();
    await inbox.getByRole("status").filter({ hasText: "已加载 4 封" }).waitFor();
    await inbox.getByRole("status").filter({ hasText: "已选择 0 封" }).waitFor();
    await button(inbox, "选择当前页邮件").click(); await inbox.getByRole("status").filter({ hasText: "已选择 4 封" }).waitFor();
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_organization_operations").first("n"), 0); await assertPlatformOnly(t, page);
  } finally { await browser?.close(); await t.close(); }
});
