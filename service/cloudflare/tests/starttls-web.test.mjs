import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { PASSWORD } from "./runtime-harness.mjs";
import { starttlsFixture, configInput } from "./starttls-runtime-fixture.mjs";

test("Chrome STARTTLS labels, read-only check, cached receive and guarded SMTP submission", { timeout: 120000 }, async () => {
  const t = await starttlsFixture(true); let browser, page;
  try {
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); page.setDefaultTimeout(15000);
    const errors = [], external = []; page.on("pageerror", e => errors.push(e.message));
    page.on("request", r => { if (!r.url().startsWith(t.h.baseUrl.origin)) external.push(r.url()); });
    await page.goto(t.h.baseUrl.href); await page.getByLabel("用户名", { exact: true }).fill(t.alice.username);
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByRole("navigation").getByRole("button", { name: "普通邮箱", exact: true }).click();
    const region = page.getByRole("region", { name: "普通邮箱", exact: true });
    await region.getByRole("button", { name: "升级邮箱", exact: true }).click();
    assert.match(await region.getByRole("combobox", { name: "IMAP 服务器", exact: true }).textContent(), /imap\.example\.test:143 STARTTLS/);
    const smtp = region.getByRole("region", { name: "普通邮箱 SMTP", exact: true });
    assert.match(await smtp.getByRole("combobox", { name: "SMTP 服务器", exact: true }).textContent(), /smtp\.example\.test:587 STARTTLS/);
    await region.getByRole("button", { name: "测试 IMAP 连接", exact: true }).click();
    await region.getByRole("status").filter({ hasText: "本次检查未同步邮件" }).waitFor();
    await region.getByRole("button", { name: "同步普通邮箱", exact: true }).click();
    await region.getByRole("status").filter({ hasText: "本批保存 2 封" }).waitFor();
    const subject = Buffer.from("5pS25Lu26aqM5pS2", "base64").toString();
    await region.getByRole("button", { name: subject, exact: true }).first().click();
    await region.getByRole("region", { name: "普通邮件详情" }).getByTestId("mail-body").filter({ hasText: "742951" }).waitFor();
    await smtp.getByLabel("SMTP 应用密码", { exact: true }).fill(configInput.password);
    await smtp.getByLabel("允许 SMTP 发信", { exact: true }).check();
    await smtp.getByRole("button", { name: "保存 SMTP 配置", exact: true }).click();
    await smtp.getByRole("status").filter({ hasText: "SMTP 配置已保存" }).waitFor();
    const send = region.getByRole("region", { name: "普通邮箱发信", exact: true });
    await send.getByLabel("收件地址", { exact: true }).fill("receiver@example.test");
    await send.getByLabel("普通邮件主题", { exact: true }).fill("网页 STARTTLS"); await send.getByLabel("普通邮件正文", { exact: true }).fill("升级后的正文");
    await send.getByRole("button", { name: "发送普通邮件", exact: true }).click();
    await send.getByRole("status").filter({ hasText: "服务器已接受，投递未确认" }).waitFor();
    assert.equal(await send.getByRole("button", { name: "发送普通邮件", exact: true }).isDisabled(), true);
    assert.equal(t.opens.length, 3); assert.equal(t.events.filter(e => e.action === "/upgrade").length, 3);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.equal(await smtp.getByLabel("SMTP 应用密码", { exact: true }).inputValue(), "");
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(t.h.directory, "starttls-mobile.png"), fullPage: true });
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
  } catch (error) { if (page) console.error(await page.locator("body").ariaSnapshot()); throw error; }
  finally { await browser?.close(); await t.close(); }
});
