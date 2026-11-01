import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { normalBatchFixture, openNormalBatch, button, combo, selection, captureNormalWrites, assertNormalPlatformOnly } from "./normal-batch-fixture.mjs";

test("Chrome: independent normal inbox batches private platform state, taxonomy and reversible trash without remote writes", { timeout: 120000 }, async () => {
  const t = await normalBatchFixture(); let browser, page;
  try {
    let inbox; ({ browser, page, inbox } = await openNormalBatch(t)); const writes = captureNormalWrites(page), errors = [], external = [];
    page.on("pageerror", failure => errors.push(failure.message));
    page.on("request", request => { if (!request.url().startsWith(t.h.baseUrl.origin)) external.push(request.url()); });
    assert.equal(await inbox.getByRole("checkbox").count(), 2); await selection(inbox, 0);
    async function batch(name, prepare = async () => {}) {
      await button(inbox, "选择当前页邮件").click(); await selection(inbox, 2);
      await prepare();
      const response = page.waitForResponse(value => value.request().method() === "POST" && value.url().endsWith("/messages/organize"));
      await button(inbox, name).click(); assert.equal((await response).status(), 200); await selection(inbox, 0);
    }
    await batch("批量标为已读"); await batch("批量加星标");
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_message_state WHERE is_read=1 AND starred=1").first("n"), 2);
    await batch("批量添加标签", () => combo(inbox, "批量标签").selectOption(t.label));
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_message_labels WHERE label_id=?").bind(t.label).first("n"), 2);
    await batch("批量移除标签", () => combo(inbox, "批量标签").selectOption(t.label));
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_message_labels").first("n"), 0);
    await batch("批量移动位置", () => combo(inbox, "批量目标文件夹").selectOption(t.folder));
    await inbox.getByText("暂无缓存邮件", { exact: true }).waitFor();
    await combo(inbox, "普通平台文件夹").selectOption(`custom:${t.folder}`); await batch("批量归档");
    await inbox.getByText("暂无缓存邮件", { exact: true }).waitFor();
    await combo(inbox, "普通平台文件夹").selectOption("archive"); await batch("批量移回收件箱");
    await combo(inbox, "普通平台文件夹").selectOption("inbox"); await batch("批量标为未读"); await batch("批量取消星标");
    await button(inbox, "选择当前页邮件").click(); await selection(inbox, 2);
    const before = writes.length; page.once("dialog", dialog => dialog.dismiss()); await button(inbox, "批量移到平台回收站").click();
    assert.equal(writes.length, before); await selection(inbox, 2);
    page.once("dialog", dialog => dialog.accept()); await button(inbox, "批量移到平台回收站").click();
    await inbox.getByText("暂无缓存邮件", { exact: true }).waitFor();
    await combo(inbox, "普通平台文件夹").selectOption("trash"); await batch("批量恢复平台邮件");
    await combo(inbox, "普通平台文件夹").selectOption("inbox"); await button(inbox, "收件验收").first().waitFor();
    assert.equal(writes.length, 11); assert.equal(new Set(writes.map(row => row.key)).size, 11);
    for (const row of writes) { assert.equal(row.path, `${t.base}/messages/organize`); assert.equal(row.body.messageIds.length, 2); }
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_message_state WHERE is_read=0 AND starred=0 AND trashed_at IS NULL").first("n"), 2);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_message_folders WHERE folder_id=?").bind(t.folder).first("n"), 0);
    await assertNormalPlatformOnly(t, page); assert.deepEqual(errors, []); assert.deepEqual(external, []);
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(t.h.directory, "normal-batch-mobile.png"), fullPage: true });
    console.log(`Normal batch browser evidence: ${t.h.directory}`);
  } catch (failure) { if (page) await page.screenshot({ path: path.join(t.h.directory, "normal-batch-failure.png"), fullPage: true }); throw failure; }
  finally { await browser?.close(); await t.close(); }
});
