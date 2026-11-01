import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { createHarness, PASSWORD } from "./runtime-harness.mjs";
import { im215Fixture, im215Mail } from "./im215-fixture.mjs";

test("Chrome: configure authorized 215.im, allocate with actual expiry, resume cursors, safely read and preserve mail on token failure", { timeout: 90000 }, async () => {
  const f = await im215Fixture(); let h, browser, page;
  try {
    h = await createHarness(f.bindings, true); const admin = await h.register("im215-web-admin");
    await h.db.prepare("INSERT INTO platform_admins VALUES (?,unixepoch())").bind(admin.id).run();
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); page.setDefaultTimeout(10000);
    const errors = [], external = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (!request.url().startsWith(h.baseUrl.origin)) external.push(request.url()); });
    await page.goto(h.baseUrl.href);
    await page.getByLabel("用户名", { exact: true }).fill("im215-web-admin"); await page.getByLabel("密码", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "登录", exact: true }).click(); await page.getByRole("button", { name: "退出登录", exact: true }).waitFor();
    await page.getByRole("combobox", { name: "域名", exact: true }).locator("option").filter({ hasText: "im215.example.test" }).waitFor({ state: "attached" });
    const startup = f.calls.length;
    await page.getByRole("button", { name: "平台管理", exact: true }).click(); await page.getByRole("heading", { name: "平台用量", exact: true }).waitFor();
    await page.getByRole("button", { name: "新增供应商", exact: true }).click(); await page.getByLabel("实例 ID", { exact: true }).fill("extra-im215");
    await page.getByRole("combobox", { name: "供应商类型", exact: true }).selectOption("im215");
    assert.equal(await page.getByLabel("发送渠道", { exact: true }).count(), 0); assert.equal(await page.getByLabel("上游访问方式", { exact: true }).count(), 0);
    await page.getByLabel("API 地址", { exact: true }).fill(f.config.baseUrl); await page.getByLabel("启用供应商", { exact: true }).check();
    await page.getByLabel("域名白名单", { exact: true }).fill("im215.example.test");
    await page.getByRole("combobox", { name: "凭据操作", exact: true }).selectOption("replace");
    await page.getByLabel("供应商 API Key", { exact: true }).fill("AC-synthetic-im215-platform-key"); await page.getByRole("button", { name: "保存供应商", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "供应商配置已保存" }).waitFor(); assert.equal(f.calls.length, startup);
    await page.getByRole("button", { name: "探测 extra-im215", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "没有已验证的只读凭据探测接口" }).waitFor(); assert.equal(f.calls.length, startup);
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(h.directory, "im215-admin-mobile.png"), fullPage: true });
    await page.getByRole("button", { name: "邮箱管理", exact: true }).click(); await page.getByRole("combobox", { name: "供应商", exact: true }).selectOption("extra-im215");
    await page.getByRole("combobox", { name: "域名", exact: true }).selectOption("im215.example.test"); await page.getByRole("button", { name: "分配随机邮箱", exact: true }).click();
    await page.getByRole("heading", { name: "收件箱", exact: true }).waitFor(); const mailbox = await h.db.prepare("SELECT * FROM mailboxes WHERE provider_id='extra-im215'").first();
    const account = f.accounts.get(mailbox.address); assert.equal(mailbox.expires_at, Math.floor(Date.parse(account.expiresAt) / 1000));
    f.messages.set(mailbox.address, Array.from({ length: 21 }, (_, n) => im215Mail(account, n + 1)));
    await page.getByRole("button", { name: "刷新收信", exact: true }).click(); await page.getByRole("button", { name: "继续同步下一页", exact: true }).waitFor();
    await h.restart(); await page.reload(); await page.getByRole("button", { name: mailbox.address, exact: true }).click();
    for (let n = 0; n < 2; n++) await page.getByRole("button", { name: "继续同步下一页", exact: true }).click();
    await page.getByRole("button", { name: "继续同步下一页", exact: true }).waitFor({ state: "detached" });
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM messages WHERE mailbox_id=?").bind(mailbox.id).first()).n, 21);
    await page.getByRole("button", { name: /^215 verify \d+$/ }).first().click(); await page.getByTestId("mail-body").waitFor();
    assert.equal(await page.getByTestId("mail-body").textContent(), "Your verification code is 852471.");
    assert.equal(await page.getByText("sample.txt", { exact: false }).count(), 1);
    await page.getByRole("button", { name: "安全 HTML", exact: true }).click(); assert.equal(await page.locator('iframe[title="安全邮件正文"]').getAttribute("sandbox"), "");
    assert.equal(await page.frameLocator('iframe[title="安全邮件正文"]').locator("b").textContent(), "852471");
    assert.equal(await page.frameLocator('iframe[title="安全邮件正文"]').locator("script,img").count(), 0); assert.equal(await page.evaluate(() => window.im215Executed), undefined);
    await page.getByRole("button", { name: "纯文本", exact: true }).click(); await page.getByRole("button", { name: "提取缓存邮件", exact: true }).click();
    assert.equal(await page.getByTestId("otp-code").first().textContent(), "852471"); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByTestId("mail-body").scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(h.directory, "im215-reader-mobile.png") });
    const text = await page.locator("body").innerText(); for (const secret of [account.token, "AC-synthetic-im215-platform-key", "synthetic-private-url"]) assert.equal(text.includes(secret), false);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    f.modes.set("/accounts/me", 401); await page.getByRole("button", { name: "刷新收信", exact: true }).click(); await page.getByRole("alert").waitFor();
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM messages WHERE mailbox_id=?").bind(mailbox.id).first()).n, 21);
    assert.equal(f.calls.filter(call => call.route === "/accounts").length, 1); assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log(`215.im Chrome evidence: ${h.directory}`);
  } catch (error) {
    if (page) { console.error(await page.locator("body").ariaSnapshot()); await page.screenshot({ path: path.join(h.directory, "im215-failure.png"), fullPage: true }); }
    throw error;
  } finally { await browser?.close(); await h?.close(); await f.close(); }
});
