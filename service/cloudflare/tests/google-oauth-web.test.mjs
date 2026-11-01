import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { PASSWORD } from "./runtime-harness.mjs";
import { googleFixture, EMAIL, ACCESS, REFRESH } from "./google-oauth-fixture.mjs";

async function browserFor(f) {
  const browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); page.setDefaultTimeout(10000);
  await page.goto(f.h.baseUrl.href); await page.getByLabel("用户名", { exact: true }).fill(f.alice.username);
  await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("navigation").getByRole("button", { name: "普通邮箱", exact: true }).click();
  return { browser, page, region: page.getByRole("region", { name: "普通邮箱", exact: true }) };
}

async function expectDisabled(page, button) {
  await button.and(page.locator(":disabled")).waitFor();
  assert.equal(await button.isDisabled(), true);
}

test("Chrome: disabled OAuth account, exact Google cross-site return, Strict session, one finalize and local disconnect", { timeout: 90000 }, async () => {
  const f = await googleFixture(true, true); let browser, page;
  try {
    const setup = await browserFor(f); ({ browser, page } = setup); const { region } = setup;
    const errors = [], external = [], completeRequests = [], callbackCookies = [];
    page.on("pageerror", e => errors.push(e.message)); page.on("request", req => {
      if (!req.url().startsWith(f.h.baseUrl.origin)) external.push(req.url());
      if (req.url().includes("/api/v1/oauth/google/complete")) completeRequests.push(req);
      if (req.url().includes("/oauth/google/callback")) callbackCookies.push(req.headers()["cookie"] ?? "");
    });
    await region.getByLabel("邮箱地址", { exact: true }).fill(EMAIL); await region.getByLabel("邮箱名称", { exact: true }).fill("Google Web 邮箱");
    await region.getByLabel("IMAP 用户名", { exact: true }).fill(EMAIL);
    assert.equal(await region.getByLabel("IMAP 应用密码", { exact: true }).count(), 0);
    await region.getByRole("button", { name: "保存普通邮箱", exact: true }).click();
    await region.getByText("账号已保存", { exact: true }).waitFor();
    const account = await f.h.db.prepare("SELECT * FROM normal_accounts").first(); assert.equal(account.enabled, 0); assert.equal(account.credential_cipher, null);
    const callbackCode = "synthetic-web-code";
    await page.route("https://accounts.google.com/o/oauth2/v2/auth?**", async route => {
      const url = new URL(route.request().url()), target = new URL(url.searchParams.get("redirect_uri"));
      target.search = new URLSearchParams({ state: url.searchParams.get("state"), code: callbackCode }).toString();
      await route.fulfill({ contentType: "text/html", body: `<html><body><a href="${target.href.replaceAll("&", "&amp;")}">Synthetic Google consent</a></body></html>` });
    });
    await region.getByRole("button", { name: "授权 Google 邮箱", exact: true }).click();
    await page.getByRole("link", { name: "Synthetic Google consent" }).click();
    await page.getByText("Google 邮箱授权已保存；SMTP 发信仍须单独启用", { exact: true }).waitFor();
    await region.getByRole("button", { name: "重新授权 Google", exact: true }).waitFor();
    assert.equal(page.url(), f.h.appOrigin + "/"); assert.equal(completeRequests.length, 1);
    assert.equal(f.calls.filter(c => c.url.endsWith("/token")).length, 1); assert.deepEqual(callbackCookies, [""]);
    assert.equal(await region.getByLabel("SMTP 应用密码", { exact: true }).count(), 0);
    await region.getByLabel("允许 SMTP 发信", { exact: true }).check();
    await expectDisabled(page, region.getByRole("button", { name: "重新授权 Google", exact: true }));
    await region.getByRole("button", { name: "保存 SMTP 配置", exact: true }).click();
    await region.getByText("SMTP 配置已保存", { exact: true }).waitFor();
    await region.getByLabel("普通邮件主题", { exact: true }).fill("未保存的 OAuth 草稿");
    await expectDisabled(page, region.getByRole("button", { name: "重新授权 Google", exact: true }));
    await expectDisabled(page, region.getByRole("button", { name: "断开 Google 授权（仅本地）", exact: true }));
    page.on("dialog", dialog => dialog.accept());
    await region.getByRole("button", { name: "新建普通邮件", exact: true }).click();
    f.mailMode("smtp", { final: "drop" });
    await region.getByLabel("收件地址", { exact: true }).fill("receiver@example.test");
    await region.getByLabel("普通邮件主题", { exact: true }).fill("未知结果必须保留原发送键");
    await region.getByLabel("普通邮件正文", { exact: true }).fill("Synthetic unknown result");
    await region.getByRole("button", { name: "发送普通邮件", exact: true }).click();
    await region.getByRole("status").filter({ hasText: "结果未知，禁止自动重发" }).waitFor();
    const originalKey = await region.getByRole("region", { name: "普通邮箱发信", exact: true }).locator("code").first().textContent();
    await expectDisabled(page, region.getByRole("button", { name: "重新授权 Google", exact: true }));
    await expectDisabled(page, region.getByRole("button", { name: "断开 Google 授权（仅本地）", exact: true }));
    await page.getByRole("navigation").getByRole("button", { name: "联系人", exact: true }).click();
    await page.getByRole("navigation").getByRole("button", { name: "普通邮箱", exact: true }).click();
    assert.equal(await region.getByRole("region", { name: "普通邮箱发信", exact: true }).locator("code").first().textContent(), originalKey);
    await region.getByRole("button", { name: "另起普通邮件", exact: true }).click();
    await region.getByRole("button", { name: "断开 Google 授权（仅本地）", exact: true }).click();
    await region.getByText("已在 EasyEmail 断开；尚未撤销 Google 端权限", { exact: true }).waitFor();
    const row = await f.h.db.prepare("SELECT * FROM normal_accounts").first(); assert.equal(row.revision, 3); assert.equal(row.enabled, 0);
    for (const secret of [ACCESS, REFRESH, callbackCode]) assert.equal((await page.locator("body").textContent()).includes(secret), false);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0); assert.deepEqual(errors, []);
    assert.equal(external.length, 1); assert.match(external[0], /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  } catch (e) { if (page) console.error(await page.locator("body").ariaSnapshot()); throw e; }
  finally { await browser?.close(); await f.close(); }
});

test("Chrome: callback fragment is removed without finalization when original session is absent", { timeout: 90000 }, async () => {
  const f = await googleFixture(true); let browser, page;
  try {
    assert.equal((await f.put()).status, 201); const started = await f.start(), state = new URL(started.body.authorizationUrl).searchParams.get("state");
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    page = await browser.newPage(); const completes = []; page.on("request", req => { if (req.url().includes("/oauth/google/complete")) completes.push(req.url()); });
    await page.goto(f.h.appOrigin + `/#ee-google-state=${state}&ee-google-code=synthetic-orphan-code`);
    await page.getByText("授权会话已失效，请登录后重新发起 Google 授权", { exact: true }).waitFor();
    assert.equal(page.url(), f.h.appOrigin + "/");
    await page.getByLabel("用户名", { exact: true }).fill(f.alice.username); await page.getByLabel("密码", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "登录", exact: true }).click(); await page.getByRole("navigation").waitFor();
    assert.deepEqual(completes, []); assert.equal(f.calls.length, 0);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  } finally { await browser?.close(); await f.close(); }
});
