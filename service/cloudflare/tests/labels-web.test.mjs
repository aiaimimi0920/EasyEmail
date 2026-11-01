import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { PASSWORD } from "./runtime-harness.mjs";
import { labelsFixture, seedMessage, organize, expect } from "./labels-fixture.mjs";

const field = (page, name) => page.getByLabel(name, { exact: true });
const button = (page, name) => page.getByRole("button", { name, exact: true });
const combo = (page, name) => page.getByRole("combobox", { name, exact: true });

test("Chrome: private labels, batch selection, filtering, lost responses, navigation and single-message labels", { timeout: 120000 }, async () => {
  const f = await labelsFixture({}, true); const { h, alice, ids } = f; let browser, page;
  try {
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); page.setDefaultTimeout(10000);
    const errors = [], external = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (!request.url().startsWith(h.baseUrl.origin)) external.push(request.url()); });
    await page.goto(h.baseUrl.href); await field(page, "用户名").fill(alice.username); await field(page, "密码").fill(PASSWORD); await button(page, "登录").click();
    await button(page, "聚合收件箱").click(); await page.getByRole("status").filter({ hasText: "已加载 2 封" }).waitFor();
    await combo(page, "邮件来源").selectOption("temporary");
    await page.getByText("管理标签", { exact: true }).click();
    await field(page, "标签名称").fill("项目蓝");
    let lostLabel = false; const labelWrites = [];
    await page.route("**/api/v1/labels/*", async route => {
      if (route.request().method() !== "PUT") return route.continue();
      labelWrites.push({ url: route.request().url(), body: route.request().postData() });
      if (!lostLabel) { lostLabel = true; await route.fetch(); await route.abort("connectionfailed"); } else await route.continue();
    });
    await button(page, "创建标签").click(); await button(page, "核对原标签操作").waitFor();
    assert.equal(await field(page, "标签名称").isDisabled(), true);
    await button(page, "核对原标签操作").click(); await button(page, "编辑标签 项目蓝").waitFor();
    assert.deepEqual(labelWrites[0], labelWrites[1]); await page.unroute("**/api/v1/labels/*");
    const label = await h.db.prepare("SELECT id FROM labels WHERE name='项目蓝'").first("id");
    await button(page, "选择当前页邮件").click(); await combo(page, "批量标签").selectOption(label); await button(page, "批量添加标签").click();
    await page.getByRole("status").filter({ hasText: "已整理 2 封邮件" }).waitFor();
    await page.getByRole("status").filter({ hasText: "已选择 0 封" }).waitFor();
    await combo(page, "标签筛选").selectOption(label); await button(page, "搜索邮件").click();
    await page.getByRole("status").filter({ hasText: "已加载 2 封" }).waitFor();
    await field(page, "选择邮件 整理邮件 1").check();
    await field(page, "搜索缓存邮件").fill("整理邮件 2"); await button(page, "搜索邮件").click();
    await page.getByRole("status").filter({ hasText: "已加载 1 封" }).waitFor();
    await page.getByRole("status").filter({ hasText: "已选择 0 封" }).waitFor();
    await field(page, "搜索缓存邮件").fill(""); await button(page, "搜索邮件").click();
    await page.getByRole("status").filter({ hasText: "已加载 2 封" }).waitFor(); await button(page, "选择当前页邮件").click();
    let lostBatch = false; const writes = [];
    await page.route("**/api/v1/messages/organize", async route => {
      writes.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
      if (!lostBatch) { lostBatch = true; await route.fetch(); await route.abort("connectionfailed"); } else await route.continue();
    });
    await button(page, "批量加星标").click(); await button(page, "核对并完成原整理").waitFor();
    const heldKey = await page.getByTestId("organization-key").textContent();
    assert.equal(await button(page, "搜索邮件").isDisabled(), true); assert.equal(await field(page, "选择邮件 整理邮件 1").isDisabled(), true);
    await button(page, "邮箱管理").click(); await button(page, "聚合收件箱").click();
    assert.equal(await page.getByTestId("organization-key").textContent(), heldKey);
    expect(await organize(h, alice, { messageIds: ids, starred: false }));
    await button(page, "核对并完成原整理").click(); await page.getByRole("status").filter({ hasText: "已核对原操作" }).waitFor();
    assert.deepEqual(writes[0], writes[1]);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM messages WHERE user_id=? AND starred=1").bind(alice.id).first("n"), 0);
    await page.unroute("**/api/v1/messages/organize");
    await button(page, "整理邮件 1").click(); const detail = page.getByRole("region", { name: "邮件标签", exact: true });
    await detail.getByRole("button", { name: "移除标签 项目蓝", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "已加载 1 封" }).waitFor();
    await button(page, "编辑标签 项目蓝").click(); await field(page, "标签名称").fill("项目绿"); await combo(page, "标签颜色").selectOption("green");
    await button(page, "保存标签修改").click(); await button(page, "编辑标签 项目绿").waitFor();
    await combo(page, "标签筛选").selectOption(""); await button(page, "搜索邮件").click();
    page.once("dialog", dialog => dialog.accept()); await button(page, "删除标签 项目绿").click();
    await button(page, "编辑标签 项目绿").waitFor({ state: "detached" });
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM message_labels").first("n"), 0);
    await page.getByRole("combobox", { name: "权限", exact: true }).selectOption("labels"); await field(page, "名称").fill("labels web key"); await button(page, "创建 Key").click();
    const token = await page.getByTestId("new-key").textContent();
    expect(await h.request("/api/v1/labels", { token, origin: null }));
    expect(await organize(h, alice, { messageIds: ids, trashed: true }, crypto.randomUUID(), { token, origin: null }), 403);
    for (let i = 3; i <= 27; i++) await seedMessage(h, alice.id, f.box, i);
    await page.reload(); await button(page, "聚合收件箱").click(); await page.getByRole("status").filter({ hasText: "已加载 25 封" }).waitFor();
    await button(page, "选择当前页邮件").click(); await page.getByRole("status").filter({ hasText: "已选择 25 封" }).waitFor();
    await button(page, "加载更多聚合邮件").click(); await page.getByRole("status").filter({ hasText: "已加载 27 封" }).waitFor();
    await button(page, "选择当前页邮件").click(); await page.getByRole("status").filter({ hasText: "已选择 2 封" }).waitFor();
    await button(page, "邮箱管理").click(); await seedMessage(h, alice.id, f.box, 28); await button(page, "聚合收件箱").click();
    await button(page, "整理邮件 28").waitFor(); await page.getByRole("status").filter({ hasText: "已选择 0 封" }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(h.directory, "labels-mobile.png"), fullPage: true });
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log(`Labels browser evidence: ${h.directory}`);
  } catch (error) {
    if (page) { console.error(await page.locator("body").ariaSnapshot()); await page.screenshot({ path: path.join(h.directory, "labels-failure.png"), fullPage: true }); }
    throw error;
  } finally { await browser?.close(); await f.close(); }
});
