import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { PASSWORD } from "./runtime-harness.mjs";
import { foldersFixture, organize, expect } from "./folders-fixture.mjs";

const field = (page, name) => page.getByLabel(name, { exact: true });
const button = (page, name) => page.getByRole("button", { name, exact: true });
const combo = (page, name) => page.getByRole("combobox", { name, exact: true });

test("Chrome: folder hierarchy, placement, filtering, archive compatibility, lost writes and safe deletion", { timeout: 120000 }, async () => {
  const f = await foldersFixture({}, true); const { h, alice, ids } = f; let browser, page;
  try {
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); page.setDefaultTimeout(10000);
    const errors = [], external = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (!request.url().startsWith(h.baseUrl.origin)) external.push(request.url()); });
    await page.goto(h.baseUrl.href); await field(page, "用户名").fill(alice.username); await field(page, "密码").fill(PASSWORD); await button(page, "登录").click();
    await button(page, "聚合收件箱").click(); await page.getByRole("status").filter({ hasText: "已加载 2 封" }).waitFor();
    await combo(page, "邮件来源").selectOption("temporary");
    await page.getByText("管理文件夹", { exact: true }).click(); await field(page, "文件夹名称").fill("项目根"); await button(page, "创建文件夹").click();
    await button(page, "编辑文件夹 项目根").waitFor(); const parent = await h.db.prepare("SELECT id FROM folders WHERE name='项目根'").first("id");
    await field(page, "文件夹名称").fill("子目录"); await combo(page, "父文件夹").selectOption(parent);
    let lostSave = false; const saved = [];
    await page.route("**/api/v1/folders/*", async route => {
      if (route.request().method() !== "PUT") return route.continue();
      saved.push({ url: route.request().url(), body: route.request().postData() });
      if (!lostSave) { lostSave = true; await route.fetch(); await route.abort("connectionfailed"); } else await route.continue();
    });
    await button(page, "创建文件夹").click(); await button(page, "核对原文件夹操作").waitFor();
    assert.equal(await field(page, "文件夹名称").isDisabled(), true); await button(page, "核对原文件夹操作").click();
    await button(page, "编辑文件夹 子目录").waitFor(); assert.deepEqual(saved[0], saved[1]); await page.unroute("**/api/v1/folders/*");
    const child = await h.db.prepare("SELECT id FROM folders WHERE name='子目录'").first("id");
    assert.equal(await combo(page, "自定义文件夹筛选").locator(`option[value="${child}"]`).textContent(), "项目根 / 子目录");
    await button(page, "选择当前页邮件").click(); await combo(page, "批量目标文件夹").selectOption(child); await button(page, "批量移动位置").click();
    await page.getByRole("status").filter({ hasText: "已加载 0 封" }).waitFor();
    await combo(page, "自定义文件夹筛选").selectOption(child); await button(page, "搜索邮件").click();
    await page.getByRole("status").filter({ hasText: "已加载 2 封" }).waitFor(); await button(page, "整理邮件 1").click();
    const detail = page.getByRole("region", { name: "邮件文件夹", exact: true });
    await detail.getByText("当前位置：子目录", { exact: true }).waitFor();
    await combo(detail, "移动到文件夹").selectOption(parent); await button(detail, "移动此邮件").click();
    await page.getByRole("status").filter({ hasText: "已加载 1 封" }).waitFor();
    await combo(page, "自定义文件夹筛选").selectOption(parent); await button(page, "搜索邮件").click();
    await button(page, "整理邮件 1").click(); await button(page, "归档").click();
    await page.getByRole("status").filter({ hasText: "已加载 0 封" }).waitFor();
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM message_folders WHERE message_id=?").bind(ids[0]).first("n"), 0);
    expect(await organize(h, alice, { messageIds: ids, folderId: child }));
    await combo(page, "自定义文件夹筛选").selectOption(child); await button(page, "搜索邮件").click();
    await page.getByRole("status").filter({ hasText: "已加载 2 封" }).waitFor(); await button(page, "选择当前页邮件").click();
    let lostMove = false; const moves = [];
    await page.route("**/api/v1/messages/organize", async route => {
      moves.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
      if (!lostMove) { lostMove = true; await route.fetch(); await route.abort("connectionfailed"); } else await route.continue();
    });
    await combo(page, "批量目标文件夹").selectOption(parent); await button(page, "批量移动位置").click(); await button(page, "核对并完成原整理").waitFor();
    const key = await page.getByTestId("organization-key").textContent();
    expect(await organize(h, alice, { messageIds: ids, folderId: child }));
    await button(page, "邮箱管理").click(); await button(page, "聚合收件箱").click(); assert.equal(await page.getByTestId("organization-key").textContent(), key);
    await button(page, "核对并完成原整理").click(); await page.getByRole("status").filter({ hasText: "已核对原操作" }).waitFor();
    assert.deepEqual(moves[0], moves[1]); await page.unroute("**/api/v1/messages/organize");
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM message_folders WHERE folder_id=?").bind(child).first("n"), 2);
    page.once("dialog", dialog => dialog.accept()); await button(page, "删除文件夹 项目根").click(); await button(page, "编辑文件夹 项目根").waitFor({ state: "detached" });
    await combo(page, "父文件夹").locator(`option[value="${child}"]`).filter({ hasText: /^子目录$/ }).waitFor({ state: "attached" });
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM message_folders WHERE folder_id=?").bind(child).first("n"), 2);
    page.once("dialog", dialog => dialog.dismiss()); await button(page, "删除文件夹 子目录").click(); assert.equal(await button(page, "编辑文件夹 子目录").count(), 1);
    let lostDelete = false; const deletions = [];
    await page.route("**/api/v1/folders/*", async route => {
      if (route.request().method() !== "DELETE") return route.continue();
      deletions.push({ url: route.request().url(), body: route.request().postData() });
      if (!lostDelete) { lostDelete = true; await route.fetch(); await route.abort("connectionfailed"); } else await route.continue();
    });
    page.once("dialog", dialog => dialog.accept()); await button(page, "删除文件夹 子目录").click(); await button(page, "核对原文件夹操作").waitFor();
    await button(page, "核对原文件夹操作").click(); await button(page, "编辑文件夹 子目录").waitFor({ state: "detached" });
    assert.deepEqual(deletions[0], deletions[1]); await page.unroute("**/api/v1/folders/*");
    await page.getByRole("status").filter({ hasText: "已加载 2 封" }).waitFor();
    await combo(page, "权限").selectOption("folders"); await field(page, "名称").fill("folder automation"); await button(page, "创建 Key").click();
    const token = await page.getByTestId("new-key").textContent(); expect(await h.request("/api/v1/folders", { token, origin: null }));
    expect(await organize(h, alice, { messageIds: ids, trashed: true }, crypto.randomUUID(), { token, origin: null }), 403);
    expect(await h.request("/api/v1/labels", { token, origin: null }), 403);
    await page.reload(); await button(page, "聚合收件箱").click(); await page.getByRole("status").filter({ hasText: "已加载 2 封" }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(h.directory, "folders-mobile.png"), fullPage: true });
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0); assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log(`Folders browser evidence: ${h.directory}`);
  } catch (error) {
    if (page) { console.error(await page.locator("body").ariaSnapshot()); await page.screenshot({ path: path.join(h.directory, "folders-failure.png"), fullPage: true }); }
    throw error;
  } finally { await browser?.close(); await f.close(); }
});
