import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { PASSWORD } from "./runtime-harness.mjs";
import { normalSendFixture, smtpInput, SMTP_PASSWORD } from "./normal-send-fixture.mjs";

async function open(t) {
  const browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); page.setDefaultTimeout(10000);
  await page.goto(t.h.baseUrl.href); await page.getByLabel("用户名", { exact: true }).fill(t.alice.username);
  await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("navigation", { name: "邮件工作台" }).getByRole("button", { name: "普通邮箱", exact: true }).click();
  const region = page.getByRole("region", { name: "普通邮箱", exact: true });
  await region.getByRole("button", { name: "普通发信邮箱", exact: true }).click();
  const smtp = page.getByRole("region", { name: "普通邮箱 SMTP", exact: true });
  await smtp.getByLabel("SMTP 用户名", { exact: true }).waitFor();
  return { browser, page, region, smtp, send: page.getByRole("region", { name: "普通邮箱发信", exact: true }) };
}

test("Chrome: SMTP validation is editable, direct send lost-response recovery is read-only and survives navigation", { timeout: 90000 }, async () => {
  const t = await normalSendFixture(true); let ui;
  try {
    ui = await open(t); const { page, smtp, send } = ui; const errors = [], external = [];
    page.on("pageerror", error => errors.push(error.message)); page.on("request", request => { if (!request.url().startsWith(t.h.baseUrl.origin)) external.push(request.url()); });
    await smtp.getByLabel("允许 SMTP 发信", { exact: true }).check(); await smtp.getByRole("button", { name: "保存 SMTP 配置", exact: true }).click();
    await smtp.getByRole("alert").filter({ hasText: "请启用账号并保存可用的 SMTP 凭据或 Google 授权配置" }).waitFor();
    assert.equal(await smtp.getByLabel("SMTP 应用密码", { exact: true }).isEnabled(), true);
    await smtp.getByLabel("SMTP 应用密码", { exact: true }).fill(SMTP_PASSWORD); await smtp.getByRole("button", { name: "保存 SMTP 配置", exact: true }).click();
    await smtp.getByRole("status").filter({ hasText: "SMTP 配置已保存" }).waitFor();
    assert.equal(await smtp.getByLabel("SMTP 应用密码", { exact: true }).inputValue(), "");
    await send.getByLabel("收件地址", { exact: true }).fill("receiver@example.test"); await send.getByLabel("密送地址", { exact: true }).fill("private@example.test");
    await send.getByLabel("普通邮件主题", { exact: true }).fill("网页普通邮件"); await send.getByLabel("普通邮件正文", { exact: true }).fill("真实浏览器，合成 SMTP");
    const posts = [], gets = []; let once = false;
    await page.route(`**/api/v1/normal-accounts/${t.id}/send`, async route => { posts.push(route.request().headers()["idempotency-key"]); await route.fetch(); await route.abort("failed"); });
    await page.route(`**/api/v1/normal-accounts/${t.id}/outgoing?requestKey=*`, async route => {
      gets.push(route.request().url()); if (!once) { once = true; return route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: { code: "rate_limited" } }) }); }
      return route.continue();
    });
    await send.getByRole("button", { name: "发送普通邮件", exact: true }).click(); await send.getByRole("alert").waitFor();
    await page.getByRole("navigation").getByRole("button", { name: "联系人", exact: true }).click();
    await page.getByRole("navigation").getByRole("button", { name: "普通邮箱", exact: true }).click();
    await send.getByRole("button", { name: "核对原普通邮件发送", exact: true }).click(); await send.getByRole("alert").filter({ hasText: "频繁" }).waitFor();
    await send.getByRole("button", { name: "核对原普通邮件发送", exact: true }).click();
    await send.getByRole("status").filter({ hasText: "服务器已接受，投递未确认" }).waitFor();
    assert.equal(posts.length, 1); assert.equal(new Set(gets).size, 1); assert.ok(gets[0].includes(posts[0])); assert.equal(t.messages.length, 1);
    assert.equal(await send.getByRole("button", { name: "发送普通邮件", exact: true }).isDisabled(), true);
    await send.getByRole("button", { name: "刷新普通发送记录", exact: true }).click(); await send.getByText("网页普通邮件", { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0); assert.equal((await page.locator("body").textContent()).includes(SMTP_PASSWORD), false);
    await page.screenshot({ path: path.join(t.h.directory, "normal-send-mobile.png"), fullPage: true }); assert.deepEqual(errors, []); assert.deepEqual(external, []);
  } catch (error) { if (ui) console.error(await ui.page.locator("body").ariaSnapshot()); throw error; }
  finally { await ui?.browser.close(); await t.close(); }
});

test("Chrome: stale SMTP configuration has an explicit refresh path and original-key config recovery", { timeout: 90000 }, async () => {
  const t = await normalSendFixture(true); let ui;
  try {
    await t.configure(); ui = await open(t); const { page, smtp } = ui;
    await t.configure({ ...smtpInput, smtpRevision: 1 });
    await smtp.getByRole("button", { name: "保存 SMTP 配置", exact: true }).click(); await smtp.getByRole("alert").filter({ hasText: "已变化" }).waitFor();
    await smtp.getByRole("button", { name: "刷新 SMTP 配置", exact: true }).click();
    await smtp.getByText("SMTP 凭据：已加密保存 · 版本 2", { exact: true }).waitFor();
    const keys = []; let first = true;
    await page.route(`**/api/v1/normal-accounts/${t.id}/smtp`, async route => {
      if (route.request().method() !== "PUT") return route.continue(); keys.push(route.request().headers()["idempotency-key"]);
      if (first) { first = false; await route.fetch(); return route.abort("failed"); } return route.continue();
    });
    await smtp.getByRole("button", { name: "保存 SMTP 配置", exact: true }).click(); await smtp.getByRole("button", { name: "核对原 SMTP 配置", exact: true }).waitFor();
    await page.getByRole("navigation").getByRole("button", { name: "联系人", exact: true }).click();
    await page.getByRole("navigation").getByRole("button", { name: "普通邮箱", exact: true }).click();
    await smtp.getByRole("button", { name: "核对原 SMTP 配置", exact: true }).click();
    await smtp.getByText("SMTP 凭据：已加密保存 · 版本 3", { exact: true }).waitFor();
    assert.equal(keys.length, 2); assert.equal(new Set(keys).size, 1); assert.equal(t.opens.length, 0);
  } catch (error) { if (ui) console.error(await ui.page.locator("body").ariaSnapshot()); throw error; }
  finally { await ui?.browser.close(); await t.close(); }
});
