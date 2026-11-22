import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { PASSWORD } from "./runtime-harness.mjs";
import { normalFixture, IMAP_PASSWORD } from "./normal-imap-fixture.mjs";

test("Chrome: normal account configuration, read-only connection test, private credentials and original-key recovery across navigation", { timeout: 90000 }, async () => {
  const t = await normalFixture(true); let browser, page;
  try {
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); page.setDefaultTimeout(10000);
    const errors = [], external = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (!request.url().startsWith(t.h.baseUrl.origin)) external.push(request.url()); });
    await page.goto(t.h.baseUrl.href);
    await page.getByLabel("用户名", { exact: true }).fill(t.alice.username);
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByRole("button", { name: "普通邮箱", exact: true }).click();
    const region = page.getByRole("region", { name: "普通邮箱", exact: true });
    await region.getByRole("button", { name: "普通邮箱", exact: true }).click();
    assert.equal(await region.getByLabel("IMAP 应用密码", { exact: true }).inputValue(), "");
    await region.getByLabel("IMAP 应用密码", { exact: true }).fill("Unsaved-synthetic-password");
    assert.equal(await region.getByRole("button", { name: "测试 IMAP 连接", exact: true }).isDisabled(), true);
    assert.equal(t.opens.length, 0);
    assert.equal(await region.getByRole("button", { name: "普通邮箱", exact: true }).isDisabled(), true);
    assert.equal(await region.getByLabel("IMAP 应用密码", { exact: true }).inputValue(), "Unsaved-synthetic-password");
    // Explicitly discard the unsaved form by reloading, never by silently reselecting the account.
    await page.reload(); await page.getByRole("navigation").getByRole("button", { name: "普通邮箱", exact: true }).click();
    await region.getByRole("button", { name: "普通邮箱", exact: true }).click();
    assert.equal(await region.getByLabel("IMAP 应用密码", { exact: true }).inputValue(), "");
    await region.getByRole("button", { name: "测试 IMAP 连接", exact: true }).click();
    await region.getByRole("status").filter({ hasText: "本次检查未同步邮件" }).waitFor();
    assert.match(await region.textContent(), /只读 INBOX：99 封/);
    await region.getByLabel("邮箱名称", { exact: true }).fill("原键恢复邮箱");
    const keys = []; let attempt = 0;
    await page.route(`**/api/v1/normal-accounts/${t.id}`, async route => {
      if (route.request().method() !== "PUT") return route.continue();
      keys.push(route.request().headers()["idempotency-key"]); attempt++;
      if (attempt === 1) { await route.fetch(); return route.abort("failed"); }
      if (attempt === 2) return route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: { code: "rate_limited" } }) });
      return route.continue();
    });
    await region.getByRole("button", { name: "保存普通邮箱", exact: true }).click();
    await region.getByRole("button", { name: "核对原账号操作", exact: true }).waitFor();
    await page.getByRole("button", { name: "联系人", exact: true }).click();
    await page.getByRole("navigation", { name: "邮件工作台" }).getByRole("button", { name: "普通邮箱", exact: true }).click();
    await region.getByRole("button", { name: "核对原账号操作", exact: true }).click();
    await region.getByRole("alert").filter({ hasText: "频繁" }).waitFor();
    await region.getByRole("button", { name: "核对原账号操作", exact: true }).click();
    await region.getByRole("status").filter({ hasText: "账号已保存" }).waitFor();
    assert.equal(keys.length, 3); assert.equal(new Set(keys).size, 1);
    assert.equal((await t.h.request(t.path, { cookie: t.alice.cookie })).body.account.revision, 2);
    assert.equal(await region.getByLabel("IMAP 应用密码", { exact: true }).inputValue(), "");
    await page.reload(); await page.getByRole("navigation").getByRole("button", { name: "普通邮箱", exact: true }).click();
    await region.getByRole("button", { name: "原键恢复邮箱", exact: true }).click();
    await region.getByLabel("允许平台连接", { exact: true }).uncheck();
    await region.getByLabel("忘记凭据（须同时关闭连接）", { exact: true }).check();
    await region.getByRole("button", { name: "保存普通邮箱", exact: true }).click();
    await region.getByText("凭据：未保存 · 版本 3", { exact: true }).waitFor();
    assert.equal(await region.getByRole("button", { name: "测试 IMAP 连接", exact: true }).isDisabled(), true);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(t.h.directory, "normal-mobile.png"), fullPage: true });
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.equal((await page.locator("body").textContent()).includes(IMAP_PASSWORD), false);
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log(`Normal account Chrome evidence: ${t.h.directory}`);
  } catch (error) {
    if (page) { console.error(await page.locator("body").ariaSnapshot()); await page.screenshot({ path: path.join(t.h.directory, "normal-failure.png"), fullPage: true }); }
    throw error;
  } finally { await browser?.close(); await t.close(); }
});
