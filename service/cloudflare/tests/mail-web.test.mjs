import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { createHarness, INVITE, PASSWORD } from "./runtime-harness.mjs";
import { cfMail, providerFixture } from "./provider-fixture.mjs";

test("Chrome: allocate, sync, text-only mail, fresh extraction, scoped key and reload", { timeout: 60000 }, async () => {
  const fixture = await providerFixture();
  let h, browser, page;
  try {
    h = await createHarness(fixture.bindings, true);
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH
      ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    const context = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
    page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    const externalRequests = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => { if (!request.url().startsWith(h.baseUrl.origin)) externalRequests.push(request.url()); });
    await page.goto(h.baseUrl.href);
    await page.getByRole("button", { name: "使用邀请口令注册", exact: true }).click();
    await page.getByLabel("用户名", { exact: true }).fill("mail-web-alice");
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD);
    await page.getByLabel("邀请口令", { exact: true }).fill(INVITE);
    await page.getByRole("button", { name: "注册", exact: true }).click();
    await page.getByRole("combobox", { name: "域名", exact: true }).selectOption("cf.example.test");
    await page.getByRole("button", { name: "分配随机邮箱", exact: true }).click();
    await page.getByRole("heading", { name: "收件箱", exact: true }).waitFor();
    const mailbox = await h.db.prepare("SELECT * FROM mailboxes LIMIT 1").first();
    fixture.messages.set(mailbox.address, [cfMail(mailbox.address, 1, "Your verification code is 724681.",
      new Date().toISOString().slice(0, 19).replace("T", " "))]);
    await page.getByRole("button", { name: "刷新收信", exact: true }).click();
    await page.getByRole("button", { name: "Verify your account", exact: true }).click();
    await page.getByTestId("mail-body").waitFor();
    assert.equal(await page.getByTestId("mail-body").textContent(), "Your verification code is 724681.");
    assert.equal(await page.evaluate(() => window.mailExecuted), undefined);
    await page.getByRole("button", { name: "提取缓存邮件", exact: true }).click();
    assert.equal(await page.getByTestId("otp-code").textContent(), "724681");
    const text = await page.locator("body").innerText();
    assert.ok(text.includes("https://auth.example.test/verify?token=synthetic"));
    assert.equal(await page.locator('a[href*="auth.example.test"]').count(), 0);
    assert.equal(text.includes("synthetic-mail-jwt"), false);
    assert.equal(text.includes("synthetic-cf-admin"), false);
    const htmlOnly = { ...cfMail(mailbox.address, 2, ""), subject: "HTML-only safety" };
    htmlOnly.html += '<img src="https://untrusted.invalid/track" onerror="window.mailExecuted=true">';
    fixture.messages.get(mailbox.address).push(htmlOnly);
    await page.getByRole("button", { name: "刷新收信", exact: true }).click();
    await page.getByRole("button", { name: "HTML-only safety", exact: true }).click();
    await page.locator("article").getByRole("heading", { name: "HTML-only safety", exact: true }).waitFor();
    assert.ok((await page.getByTestId("mail-body").textContent()).includes("<script>"));
    assert.equal(await page.locator("article script, article img, article a").count(), 0);
    assert.equal(await page.evaluate(() => window.mailExecuted), undefined);
    assert.deepEqual(externalRequests, []);

    // Lost success -> throttled status check -> successful replay must retain one request key.
    const beforeCreates = fixture.calls.filter((call) => call.path === "/cf/admin/new_address").length;
    const requestKeys = [];
    let stage = 0;
    await page.route("**/api/v1/mailboxes", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      requestKeys.push(route.request().headers()["idempotency-key"]);
      stage++;
      if (stage === 1) { await route.fetch(); return route.abort("failed"); }
      if (stage === 2) return route.fulfill({ status: 429, contentType: "application/json", body: '{"error":{"code":"rate_limited"}}' });
      return route.continue();
    });
    await page.getByRole("button", { name: "分配随机邮箱", exact: true }).click();
    await page.getByRole("button", { name: "检查创建结果", exact: true }).waitFor();
    await page.getByRole("button", { name: "聚合收件箱", exact: true }).click();
    await page.getByRole("button", { name: "邮箱管理", exact: true }).click();
    await page.getByRole("button", { name: "检查创建结果", exact: true }).waitFor();
    await page.getByRole("button", { name: "检查创建结果", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "操作过于频繁" }).waitFor();
    await page.getByRole("button", { name: "检查创建结果", exact: true }).click();
    await page.getByRole("button", { name: "分配随机邮箱", exact: true }).waitFor();
    assert.equal(requestKeys.length, 3);
    assert.equal(new Set(requestKeys).size, 1);
    assert.equal(fixture.calls.filter((call) => call.path === "/cf/admin/new_address").length, beforeCreates + 1);
    await page.unroute("**/api/v1/mailboxes");

    await page.getByLabel("名称", { exact: true }).fill("mail automation");
    await page.getByRole("combobox", { name: "权限", exact: true }).selectOption("manage");
    await page.getByRole("button", { name: "创建 Key", exact: true }).click();
    const token = await page.getByTestId("new-key").textContent();
    assert.equal((await h.request(`/api/v1/mailboxes/${mailbox.id}/messages`, { token, origin: null })).status, 200);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    await page.reload();
    await page.getByRole("button", { name: mailbox.address, exact: true }).click();
    await page.getByRole("button", { name: "Verify your account", exact: true }).waitFor();
    assert.equal(await page.getByTestId("new-key").count(), 0);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(h.directory, "mail-mobile.png"), fullPage: true });
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await page.getByRole("button", { name: "登录", exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log(`M2 Chrome evidence: ${h.directory}`);
  } catch (error) {
    if (page) {
      console.error(await page.locator("body").ariaSnapshot());
      await page.screenshot({ path: path.join(h.directory, "mail-failure.png"), fullPage: true });
    }
    throw error;
  } finally { await browser?.close(); await h?.close(); await fixture.close(); }
});
