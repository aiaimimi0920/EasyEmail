import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { PASSWORD } from "./runtime-harness.mjs";
import { agentGoogleFixture } from "./agent-google-oauth-fixture.mjs";
import { EMAIL, ACCESS, REFRESH } from "./google-oauth-fixture.mjs";

test("Chrome: Agent Google consent returns to Agent, keeps SMTP/automation opt-in and reconciles the original disconnect across navigation", { timeout: 90000 }, async () => {
  const f = await agentGoogleFixture(true); let browser, page;
  try {
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); page.setDefaultTimeout(12000);
    const errors = [], completes = [], callbackCookies = [], disconnects = [], external = [];
    page.on("pageerror", error => errors.push(error.message)); page.on("dialog", dialog => dialog.accept());
    page.on("request", request => {
      if (!request.url().startsWith(f.h.baseUrl.origin)) external.push(request.url());
      if (request.url().includes("/oauth/google/complete")) completes.push(request.postDataJSON());
      if (request.url().includes("/oauth/google/callback")) callbackCookies.push(request.headers()["cookie"] ?? "");
      if (request.url().endsWith("/oauth/google/disconnect")) disconnects.push({ key: request.headers()["idempotency-key"], body: request.postDataJSON() });
    });
    await page.goto(f.h.baseUrl.href); await page.getByLabel("用户名", { exact: true }).fill(f.alice.username);
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await page.getByRole("button", { name: "登录", exact: true }).click();
    const nav = page.getByRole("navigation"); await nav.getByRole("button", { name: "Agent 邮箱", exact: true }).click();
    const region = page.getByRole("region", { name: "Agent 邮箱", exact: true });
    await region.getByLabel("邮箱地址", { exact: true }).fill(EMAIL); await region.getByLabel("邮箱名称", { exact: true }).fill("Google Agent Web");
    await region.getByLabel("IMAP 用户名", { exact: true }).fill(EMAIL);
    assert.equal(await region.getByLabel("IMAP 应用密码", { exact: true }).count(), 0);
    await region.getByRole("button", { name: "保存 Agent 邮箱", exact: true }).click(); await region.getByText("Agent 账号已保存", { exact: true }).waitFor();
    const row = await f.h.db.prepare("SELECT * FROM agent_accounts").first(); assert.equal(row.enabled, 0); assert.equal(row.credential_cipher, null);
    await page.route("https://accounts.google.com/o/oauth2/v2/auth?**", async route => {
      const url = new URL(route.request().url()), target = new URL(url.searchParams.get("redirect_uri"));
      target.search = new URLSearchParams({ state: url.searchParams.get("state"), code: "synthetic-agent-web-code" }).toString();
      await route.fulfill({ contentType: "text/html", body: `<a href="${target.href.replaceAll("&", "&amp;")}">Synthetic Agent consent</a>` });
    });
    await region.getByRole("button", { name: "授权 Google 邮箱", exact: true }).click(); await page.getByRole("link", { name: "Synthetic Agent consent" }).click();
    await page.getByText("Google 邮箱授权已保存；SMTP 发信仍须单独启用", { exact: true }).waitFor();
    await region.getByRole("button", { name: "重新授权 Google", exact: true }).waitFor();
    assert.equal(page.url(), f.h.appOrigin + "/"); assert.equal(completes.length, 1); assert.deepEqual(callbackCookies, [""]);
    assert.equal(await nav.getByRole("button", { name: "Agent 邮箱", exact: true }).getAttribute("aria-pressed"), "true");
    assert.equal(await region.getByLabel("Agent SMTP 应用密码", { exact: true }).count(), 0);
    const smtp = region.getByLabel("启用 Agent SMTP 配置", { exact: true }); assert.equal(await smtp.isChecked(), false);
    await smtp.check(); await region.getByRole("button", { name: "重新授权 Google", exact: true }).and(page.locator(":disabled")).waitFor();
    await region.getByRole("button", { name: "保存 Agent SMTP 配置", exact: true }).click(); await region.getByText("Agent SMTP 配置操作已确认", { exact: true }).waitFor();
    const automatic = region.getByRole("region", { name: "Agent 自动收件", exact: true });
    assert.equal(await f.h.db.prepare("SELECT COUNT(*) n FROM agent_inbox_automation").first("n"), 0);
    const oauth = region.getByRole("button", { name: "断开 Google 授权（仅本地）", exact: true }); await oauth.and(page.locator(":enabled")).waitFor();
    let lost = true;
    await page.route("**/api/v1/agent-accounts/*/oauth/google/disconnect", async route => {
      if (!lost) return route.continue(); lost = false; await route.fetch(); await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":{"code":"synthetic_ack_lost"}}' });
    });
    await oauth.click(); const recover = region.getByRole("button", { name: "核对原授权操作", exact: true }); await recover.waitFor();
    assert.equal(await region.getByRole("button", { name: "保存 Agent SMTP 配置", exact: true }).isDisabled(), true);
    await nav.getByRole("button", { name: "联系人", exact: true }).click(); await nav.getByRole("button", { name: "Agent 邮箱", exact: true }).click();
    await recover.click(); await region.getByText("已在 EasyEmail 断开；尚未撤销 Google 端权限", { exact: true }).waitFor();
    assert.equal(disconnects.length, 2); assert.deepEqual(disconnects[0], disconnects[1]);
    assert.equal(await f.h.db.prepare("SELECT COUNT(*) n FROM agent_google_oauth_disconnects").first("n"), 1);
    assert.equal(await f.h.db.prepare("SELECT COUNT(*) n FROM normal_accounts").first("n"), 0);
    const body = await page.locator("body").textContent(); for (const secret of [ACCESS, REFRESH, "synthetic-agent-web-code"]) assert.equal(body.includes(secret), false);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0); assert.deepEqual(errors, []);
    assert.equal(external.length, 1); assert.equal(f.calls.filter(call => call.url.endsWith("/token")).length, 1);
    assert.equal(await automatic.count(), 1); await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: path.join(f.h.directory, "agent-google-oauth-mobile.png"), fullPage: true });
  } catch (error) { if (page) console.error(await page.locator("body").ariaSnapshot()); throw error; }
  finally { await browser?.close(); await f.close(); }
});

test("Chrome: Agent list, reload, pagination and authorization detail reject normal or wrong-identity DTOs without replacing trusted state", { timeout: 90000 }, async () => {
  const f = await agentGoogleFixture(true); let browser, page;
  try {
    assert.equal((await f.put()).status, 201);
    const account = (await f.h.request(f.path, { cookie: f.alice.cookie })).body.account;
    const normal = { ...account, scope: "normal", displayName: "Wrong scope account" };
    let mode = "list", cursor = null;
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    page = await browser.newPage(); page.setDefaultTimeout(10000);
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/v1/agent-accounts**", route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/v1/agent-accounts") return route.fulfill({ json: {
        items: mode === "list" || mode === "more" && url.searchParams.has("cursor") ? [normal] : [account], nextCursor: cursor } });
      if (url.pathname === f.path && mode === "detail") return route.fulfill({ json: { account: normal } });
      if (url.pathname === f.path && mode === "identity") return route.fulfill({ json: { account: { ...account, id: crypto.randomUUID() } } });
      return route.continue();
    });
    await page.goto(f.h.baseUrl.href); await page.getByLabel("用户名", { exact: true }).fill(f.alice.username);
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await page.getByRole("button", { name: "登录", exact: true }).click();
    const nav = page.getByRole("navigation"); await nav.getByRole("button", { name: "Agent 邮箱", exact: true }).click();
    const region = page.getByRole("region", { name: "Agent 邮箱", exact: true });
    const invalid = region.getByRole("alert").filter({ hasText: "Agent 邮箱选项响应无效" }); await invalid.waitFor();
    assert.equal(await region.getByRole("button", { name: normal.displayName, exact: true }).count(), 0);
    mode = "valid"; await region.getByRole("button", { name: "刷新 Agent 邮箱", exact: true }).click();
    await region.getByRole("button", { name: account.displayName, exact: true }).click();
    for (const next of ["list", "detail", "identity"]) {
      mode = next; await region.getByRole("button", { name: "刷新 Agent 邮箱", exact: true }).click(); await invalid.waitFor();
      assert.equal(await region.getByLabel("邮箱名称", { exact: true }).inputValue(), account.displayName);
      assert.equal(await region.getByRole("button", { name: normal.displayName, exact: true }).count(), 0);
    }
    mode = "more"; cursor = account.id; await region.getByRole("button", { name: "刷新 Agent 邮箱", exact: true }).click();
    await region.getByRole("button", { name: "加载更多 Agent 邮箱", exact: true }).click(); await invalid.waitFor();
    assert.equal(await region.getByRole("button", { name: normal.displayName, exact: true }).count(), 0);
    const start = await page.evaluate(async url => {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: '{"expectedRevision":1}' });
      return { status: response.status, body: await response.json() };
    }, f.path + "/oauth/google/start");
    assert.equal(start.status, 200); const state = new URL(start.body.authorizationUrl).searchParams.get("state");
    mode = "detail"; cursor = null;
    await page.goto("about:blank");
    await page.goto(f.h.appOrigin + `/#ee-google-state=${state}&ee-google-code=synthetic-agent-dto-code`);
    await invalid.waitFor(); assert.equal(await region.getByRole("button", { name: "重新授权 Google", exact: true }).count(), 0);
    assert.equal(await region.getByRole("region", { name: "Agent 邮箱连接状态", exact: true }).count(), 0);
    mode = "valid"; await nav.getByRole("button", { name: "联系人", exact: true }).click();
    await nav.getByRole("button", { name: "Agent 邮箱", exact: true }).click();
    await region.getByRole("button", { name: "重新授权 Google", exact: true }).waitFor();
    assert.deepEqual(errors, []); assert.equal(f.calls.filter(call => call.url.endsWith("/token")).length, 1);
  } catch (error) { if (page) console.error(await page.locator("body").ariaSnapshot()); throw error; }
  finally { await browser?.close(); await f.close(); }
});
