import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { folderOrganizationFixture, expect } from "./normal-folder-organization-fixture.mjs";
import { putLabel, labelBody } from "./labels-fixture.mjs";
import { putFolder, folderBody } from "./folders-fixture.mjs";
import { PASSWORD } from "./runtime-harness.mjs";

const button = (p, name) => p.getByRole("button", { name, exact: true });
async function open(t) {
  const browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); page.setDefaultTimeout(15000);
    await page.goto(t.h.baseUrl.href); await page.getByLabel("用户名", { exact: true }).fill(t.alice.username);
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await button(page, "登录").click();
    await button(page.getByRole("navigation"), "聚合收件箱").click();
    const inbox = page.getByRole("region", { name: "聚合邮件", exact: true }); await inbox.getByText("已加载 6 封", { exact: true }).waitFor();
    return { browser, page, inbox };
  } catch (error) { await browser.close(); throw error; }
}
test("Chrome: aggregate directory batches and detail taxonomy share exact paths with the independent folder workbench", { timeout: 180000 }, async () => {
  const t = await folderOrganizationFixture({ browser: true }); let browser, page;
  try {
    const label = crypto.randomUUID(), location = crypto.randomUUID();
    expect(await putLabel(t.h, t.alice, label, labelBody("目录标签")), 201); expect(await putFolder(t.h, t.alice, location, folderBody("目录位置")), 201);
    let inbox; ({ browser, page, inbox } = await open(t)); const writes = [], errors = [], external = [], remote = [];
    page.on("pageerror", error => errors.push(error.message)); page.on("request", request => {
      if (!request.url().startsWith(t.h.baseUrl.origin)) external.push(request.url());
      if (request.method() === "POST") writes.push({ path: new URL(request.url()).pathname, key: request.headers()["idempotency-key"], body: request.postDataJSON() });
      if (/remote-flags|remote-flag-operations|\/reply(?:\?|$)/.test(request.url())) remote.push({ method: request.method(), path: new URL(request.url()).pathname });
    });
    await button(inbox, "选择当前页邮件").click(); assert.equal(await inbox.getByRole("checkbox", { checked: true }).count(), 6);
    await button(inbox, "批量标为已读").click(); await page.getByRole("status").filter({ hasText: "已完成 6 封；拒绝 0 组；未确认 0 组" }).waitFor();
    assert.equal(writes.length, 3); assert.equal(new Set(writes.map(row => row.key)).size, 3);
    assert.deepEqual(new Set(writes.map(row => row.path)), new Set([`${t.base}/messages/organize`, `${t.folderPath("Sent")}/messages/organize`, `${t.folderPath("&Ti1lhw-")}/messages/organize`]));
    assert.ok(writes.every(row => row.body.messageIds.length === 2));
    await button(inbox, "Sent projection 1").click(); const detail = inbox.getByRole("region", { name: "普通邮件详情", exact: true });
    await button(detail, "标为未读").waitFor(); await button(detail, "加星标").click(); await button(detail, "取消星标").waitFor();
    await detail.getByRole("combobox", { name: "添加邮件标签", exact: true }).selectOption(label); await button(detail, "添加到此邮件").click();
    await button(detail, "移除标签 目录标签").waitFor();
    await detail.getByRole("combobox", { name: "移动到文件夹", exact: true }).selectOption(location); await button(detail, "移动此邮件").click();
    await detail.getByText("当前位置：目录位置", { exact: true }).waitFor();
    assert.ok(writes.slice(3).every(row => row.path === `${t.folderPath("Sent")}/messages/organize`));
    await page.screenshot({ path: path.join(t.h.directory, "folder-organization-aggregate-mobile.png"), fullPage: true });
    await button(page.getByRole("navigation"), "普通邮箱").click(); const account = page.getByRole("region", { name: "普通邮箱", exact: true });
    await button(account, "普通邮箱").click(); await button(account, "查看 Sent 邮件").click();
    const folder = account.getByRole("region", { name: "服务器文件夹邮件", exact: true }); await button(folder, "Sent projection 1").waitFor();
    await button(folder, "选择当前页邮件").click(); await button(folder, "批量取消星标").click();
    await page.getByText("已整理 2 封普通邮件", { exact: true }).waitFor(); await button(folder, "Sent projection 1").click();
    const folderDetail = folder.getByRole("region", { name: "服务器文件夹邮件详情", exact: true }); await button(folderDetail, "加星标").waitFor();
    await button(folderDetail, "移除标签 目录标签").waitFor(); await folderDetail.getByText("当前位置：目录位置", { exact: true }).waitFor();
    await page.screenshot({ path: path.join(t.h.directory, "folder-organization-directory-mobile.png"), fullPage: true });
    const flagPath = `${t.folderPath("Sent")}/messages/${writes[3].body.messageIds[0]}/remote-flags`;
    assert.ok(remote.length > 0); assert.ok(remote.every(row => row.method === "GET" && row.path === flagPath));
    assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(t.opens.length, 4);
    assert.equal(t.calls.some(line => /STORE|EXPUNGE|COPY|MOVE/.test(line)), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    console.log(`Folder organization Chrome evidence: ${t.h.directory}`);
  } catch (error) { if (page) { console.error(await page.locator("body").ariaSnapshot()); await page.screenshot({ path: path.join(t.h.directory, "folder-organization-failure.png"), fullPage: true }); } throw error; }
  finally { await browser?.close(); await t.close(); }
});

for (const readOnly of [true, false]) test(`Chrome: mismatched directory receipt retains its original owner across navigation and catalog removal; readOnly=${readOnly}`, { timeout: 90000 }, async () => {
  const t = await folderOrganizationFixture({ browser: true }); let browser;
  try {
    const { page, inbox, ...rest } = await open(t); browser = rest.browser; const writes = []; let first = true;
    await page.route(`**${t.folderPath("Sent")}/messages/organize`, async route => {
      writes.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() });
      const response = await route.fetch(), result = await response.json();
      if (first) { first = false; result.operation.serverFolderId = t.folder("&Ti1lhw-").id; }
      await route.fulfill({ response, json: result });
    });
    await button(inbox, "Sent projection 1").click(); await button(inbox, "标为已读").click();
    await page.getByRole("alert").filter({ hasText: "整理回执不匹配" }).waitFor(); await button(page, "核对原普通整理").waitFor();
    expect(await t.organize("Sent", writes[0].body.messageIds, { isRead: false }));
    await t.h.db.prepare("UPDATE normal_server_folder_catalogs SET folders='[]' WHERE account_id=?").bind(t.id).run();
    await button(page.getByRole("navigation"), "联系人").click();
    await button(page, readOnly ? "核对原普通整理" : "重试原普通整理").click();
    await page.getByRole("status").filter({ hasText: "已核对原操作" }).waitFor();
    assert.equal(writes.length, readOnly ? 1 : 2); if (!readOnly) assert.deepEqual(writes[0], writes[1]);
    const state = await t.h.db.prepare("SELECT is_read FROM normal_message_state WHERE message_id=?").bind(writes[0].body.messageIds[0]).first();
    assert.equal(state.is_read, 0); assert.equal(t.opens.length, 4);
  } finally { await browser?.close(); await t.close(); }
});
