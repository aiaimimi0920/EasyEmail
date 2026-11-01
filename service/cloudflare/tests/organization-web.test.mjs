import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { createHarness, INVITE, PASSWORD } from "./runtime-harness.mjs";
import { cfMail, providerFixture } from "./provider-fixture.mjs";

test("Chrome: organize mailboxes, aggregate two providers, paginate, search and persist message state", { timeout: 90000 }, async () => {
  const f = await providerFixture();
  let h, browser, page;
  try {
    h = await createHarness(f.bindings, true);
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH
      ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
    page.setDefaultTimeout(10000);
    const errors = [], external = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => { if (!request.url().startsWith(h.baseUrl.origin)) external.push(request.url()); });
    await page.goto(h.baseUrl.href);
    await page.getByRole("button", { name: "使用邀请口令注册", exact: true }).click();
    await page.getByLabel("用户名", { exact: true }).fill("workspace-web-alice");
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD);
    await page.getByLabel("邀请口令", { exact: true }).fill(INVITE);
    await page.getByRole("button", { name: "注册", exact: true }).click();
    await page.getByRole("combobox", { name: "域名", exact: true }).selectOption("cf.example.test");
    await page.getByRole("button", { name: "分配随机邮箱", exact: true }).click();
    await page.getByRole("heading", { name: "收件箱", exact: true }).waitFor();
    const box = await h.db.prepare("SELECT * FROM mailboxes LIMIT 1").first();
    f.messages.set(box.address, Array.from({ length: 26 }, (_, i) => ({
      ...cfMail(box.address, i, "Your verification code is 654321.", i === 25 ? "1970-01-01 00:00:00" : "2026-10-28 01:00:00"),
      subject: i === 0 ? "Project note" : `Notice ${i}`,
    })));
    await page.getByRole("button", { name: "刷新收信", exact: true }).click();
    for (let i = 0; i < 2; i++) {
      await page.getByRole("button", { name: "继续同步下一页", exact: true }).click();
      await page.getByRole("status").filter({ hasText: i === 0 ? "本页读取 10 封" : "本页读取 6 封" }).waitFor();
    }
    await page.getByLabel("邮箱名称", { exact: true }).fill("项目收件箱");
    await page.getByLabel("邮箱备注", { exact: true }).fill("测试备注\n保留第二行");
    await page.getByLabel("收藏邮箱", { exact: true }).check();
    await page.getByRole("button", { name: "保存邮箱设置", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "已保存" }).waitFor();
    await page.getByRole("button", { name: "暂停平台同步", exact: true }).click();
    await page.getByRole("button", { name: "恢复平台同步", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "刷新收信", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "恢复平台同步", exact: true }).click();
    await page.getByRole("button", { name: "暂停平台同步", exact: true }).waitFor();
    await page.getByRole("combobox", { name: "供应商", exact: true }).selectOption("temporam");
    await page.getByRole("combobox", { name: "域名", exact: true }).selectOption("temp.example.test");
    const created = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/mailboxes" && response.request().method() === "POST");
    await page.getByRole("button", { name: "分配随机邮箱", exact: true }).click();
    const temp = (await (await created).json()).mailbox;
    await page.getByRole("region", { name: "邮箱设置", exact: true }).getByText(temp.address, { exact: true }).waitFor();
    assert.equal(await page.getByRole("region", { name: "邮箱设置", exact: true }).count(), 1);
    f.messages.set(temp.address, [{ id: "temp/workspace", toEmail: temp.address, fromEmail: "temp@sender.test",
      subject: "Temp welcome", content: "Temporam cached message", createdAt: "2026-10-28T01:00:01Z" }]);
    await page.getByRole("button", { name: "刷新收信", exact: true }).click();
    await page.getByRole("button", { name: "Temp welcome", exact: true }).waitFor();
    const calls = f.calls.length;
    await page.getByRole("button", { name: "聚合收件箱", exact: true }).click();
    await page.getByRole("combobox", { name: "邮件来源", exact: true }).selectOption("temporary");
    await page.getByRole("button", { name: "搜索邮件", exact: true }).click();
    await page.getByRole("button", { name: "Temp welcome", exact: true }).waitFor();
    await page.getByRole("button", { name: "加载更多聚合邮件", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "已加载 27 封" }).waitFor();
    assert.equal(await page.getByRole("region", { name: "聚合邮件", exact: true }).getByText(/1970/).count(), 1);
    // A slow response for the previous search must not replace the new search's results.
    let releaseSlow, enteredSlow;
    const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
    const slowEntered = new Promise((resolve) => { enteredSlow = resolve; });
    await page.route("**/api/v1/messages?**", async (route) => {
      if (new URL(route.request().url()).searchParams.get("q") !== "Notice") return route.continue();
      const response = await route.fetch(); enteredSlow(); await slowGate; await route.fulfill({ response });
    });
    const oldResponse = page.waitForResponse((response) => new URL(response.url()).searchParams.get("q") === "Notice");
    try {
      await page.getByLabel("搜索缓存邮件", { exact: true }).fill("Notice");
      await page.getByRole("button", { name: "搜索邮件", exact: true }).click();
      await slowEntered;
      await page.getByLabel("搜索缓存邮件", { exact: true }).fill("project");
      await page.getByRole("button", { name: "搜索邮件", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "已加载 1 封" }).waitFor();
    } finally { releaseSlow(); }
    await oldResponse;
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.getByRole("region", { name: "聚合邮件", exact: true }).getByRole("button", { name: /^Notice / }).count(), 0);
    await page.unroute("**/api/v1/messages?**");
    await page.getByLabel("搜索缓存邮件", { exact: true }).fill("project");
    await page.getByRole("button", { name: "搜索邮件", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "已加载 1 封" }).waitFor();
    await page.getByRole("button", { name: "Project note", exact: true }).click();
    await page.getByRole("button", { name: "标为已读", exact: true }).click();
    await page.getByRole("button", { name: "标为未读", exact: true }).waitFor();
    await page.getByRole("button", { name: "加星标", exact: true }).click();
    await page.getByRole("button", { name: "取消星标", exact: true }).waitFor();
    await page.getByRole("button", { name: "归档", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "已加载 0 封" }).waitFor();
    await page.getByRole("combobox", { name: "文件夹", exact: true }).selectOption("archive");
    await page.getByRole("combobox", { name: "阅读状态", exact: true }).selectOption("true");
    await page.getByRole("combobox", { name: "星标筛选", exact: true }).selectOption("true");
    await page.getByRole("button", { name: "搜索邮件", exact: true }).click();
    await page.getByRole("button", { name: "Project note", exact: true }).click();
    await page.getByRole("button", { name: "移回收件箱", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "已加载 0 封" }).waitFor();
    assert.equal(f.calls.length, calls, "Cached browsing and organization must not call providers");
    await page.getByRole("combobox", { name: "权限", exact: true }).selectOption("organize");
    await page.getByLabel("名称", { exact: true }).fill("workspace automation");
    await page.getByRole("button", { name: "创建 Key", exact: true }).click();
    const token = await page.getByTestId("new-key").textContent();
    const message = await h.db.prepare("SELECT id FROM messages WHERE subject = 'Project note'").first();
    assert.equal((await h.request(`/api/v1/mailboxes/${box.id}/messages/${message.id}`, { token, method: "PATCH", origin: null, body: { archived: true } })).status, 200);
    await page.reload();
    await page.getByRole("button", { name: box.address, exact: true }).click();
    assert.equal(await page.getByLabel("邮箱名称", { exact: true }).inputValue(), "项目收件箱");
    assert.equal(await page.getByLabel("邮箱备注", { exact: true }).inputValue(), "测试备注\n保留第二行");
    assert.equal(await page.getByLabel("收藏邮箱", { exact: true }).isChecked(), true);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    await page.getByRole("button", { name: "聚合收件箱", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "已加载 25 封" }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(h.directory, "organization-mobile.png"), fullPage: true });
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log(`M3 Chrome evidence: ${h.directory}`);
  } catch (error) {
    if (page) { console.error(await page.locator("body").ariaSnapshot()); await page.screenshot({ path: path.join(h.directory, "organization-failure.png"), fullPage: true }); }
    throw error;
  } finally { await browser?.close(); await h?.close(); await f.close(); }
});
