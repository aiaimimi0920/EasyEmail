import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { confirmAction } from "./confirmation-driver.mjs";
import { CLIENT_ID, ISSUER, naccountFixture } from "./naccount-auth-fixture.mjs";
import { newKey, PASSWORD, seedMailbox } from "./runtime-harness.mjs";

test("Chrome: NAccount PKCE redirect, callback cleanup, legacy vmjcv666 admin link, credential revoke and SSO logout", { timeout: 90000 }, async () => {
  const f = await naccountFixture({ browser: true });
  let browser;
  let page;
  try {
    const legacyId = crypto.randomUUID();
    const salt = "abcdef0123456789abcdef0123456789";
    const derived = scryptSync(PASSWORD, salt, 32, { N: 16384, r: 8, p: 5, maxmem: 33554432 }).toString("hex");
    await f.h.db.prepare("INSERT INTO users(id, username, password_hash, status, created_at) VALUES (?, 'vmjcv666', ?, 'active', unixepoch())")
      .bind(legacyId, `scrypt$16384$8$5$${salt}$${derived}`).run();
    await seedMailbox(f.h, legacyId, "vmjcv666@aiaimimi.com");

    browser = await chromium.launch({
      executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
      headless: true,
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    page.setDefaultTimeout(12000);
    const errors = [];
    const seenAuthRequests = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.route(`${ISSUER}/login?**`, async (route) => {
      const url = new URL(route.request().url());
      seenAuthRequests.push(Object.fromEntries(url.searchParams.entries()));
      const screen = url.searchParams.get("screen");
      if (screen === "signup") {
        const deniedUrl = new URL(url.searchParams.get("redirect_uri"));
        deniedUrl.search = new URLSearchParams({ error: "access_denied", state: url.searchParams.get("state") }).toString();
        await route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html><body><a href="${deniedUrl.href.replaceAll("&", "&amp;")}">Cancel NAccount signup</a></body></html>`,
        });
        return;
      }
      const issued = f.issueCode({
        sub: "e7b183d6-a81f-485a-9c89-32750b1346d0",
        email: "vmjcv666@gmail.com",
        roles: ["super_admin"],
        codeChallenge: url.searchParams.get("code_challenge"),
      });
      const callbackUrl = new URL(url.searchParams.get("redirect_uri"));
      callbackUrl.search = new URLSearchParams({ code: issued.code, state: url.searchParams.get("state"), iss: ISSUER }).toString();
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><body><a href="${callbackUrl.href.replaceAll("&", "&amp;")}">Approve NAccount login</a></body></html>`,
      });
    });

    await page.route(`${ISSUER}/oauth2/v1/logout?**`, async (route) => {
      const url = new URL(route.request().url());
      assert.equal(url.searchParams.get("client_id"), CLIENT_ID);
      assert.equal(url.searchParams.get("post_logout_redirect_uri"), f.h.appOrigin);
      const back = new URL("/", url.searchParams.get("post_logout_redirect_uri"));
      back.searchParams.set("state", url.searchParams.get("state"));
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><body><a href="${back.href.replaceAll("&", "&amp;")}">Complete SSO logout</a></body></html>`,
      });
    });

    await page.goto(f.h.baseUrl.href);
    const loginButton = page.getByRole("button", { name: "使用 NAccount 登录", exact: true });
    await loginButton.waitFor();
    assert.match(await loginButton.getAttribute("class"), /n-button--primary/);
    assert.equal(await page.getByLabel("用户名", { exact: true }).count(), 0);
    assert.equal(await page.getByLabel("密码", { exact: true }).count(), 0);

    await page.getByRole("button", { name: "注册 NAccount 账号", exact: true }).click();
    await page.getByRole("link", { name: "Cancel NAccount signup" }).click();
    await page.getByRole("alert").filter({ hasText: "已取消 NAccount 登录授权" }).waitFor();
    assert.equal(page.url(), `${f.h.appOrigin}/`);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.equal(seenAuthRequests[0].screen, "signup");
    assert.equal(seenAuthRequests[0].code_challenge_method, "S256");

    await page.getByRole("button", { name: "使用 NAccount 登录", exact: true }).click();
    await page.getByRole("link", { name: "Approve NAccount login" }).click();
    await page.getByRole("navigation", { name: "邮件工作台", exact: true }).waitFor();
    await page.getByText("vmjcv666@aiaimimi.com", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "平台管理", exact: true }).count(), 1);
    assert.equal(page.url(), `${f.h.appOrigin}/`);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);

    const browserCookies = await context.cookies();
    const session = browserCookies.find((item) => item.name === "__Host-ee_session");
    assert.ok(session);
    assert.equal(session.httpOnly, true);
    assert.equal(session.sameSite, "Strict");
    const key = await newKey(f.h, `__Host-ee_session=${session.value}`);

    await page.getByRole("button", { name: "账号安全", exact: true }).click();
    const securityPanel = page.getByRole("region", { name: "账号安全", exact: true });
    const portalLink = securityPanel.getByRole("link", { name: "前往 NAccount 账号中心", exact: true });
    assert.equal(await portalLink.getAttribute("href"), `${ISSUER}/account`);
    assert.equal(await portalLink.getAttribute("target"), "_blank");

    await confirmAction(
      page,
      () => securityPanel.getByRole("button", { name: "撤销本应用全部会话与 API Key", exact: true }).click(),
      (dialog) => dialog.dismiss(),
    );
    assert.equal((await f.h.request("/api/v1/mailboxes", { token: key.token, origin: null })).status, 200);

    await confirmAction(
      page,
      () => securityPanel.getByRole("button", { name: "撤销本应用全部会话与 API Key", exact: true }).click(),
      (dialog) => dialog.accept(),
    );
    await page.getByRole("button", { name: "使用 NAccount 登录", exact: true }).waitFor();
    assert.equal((await f.h.request("/api/v1/mailboxes", { token: key.token, origin: null })).status, 401);

    await page.getByRole("button", { name: "使用 NAccount 登录", exact: true }).click();
    await page.getByRole("link", { name: "Approve NAccount login" }).click();
    await page.getByRole("button", { name: "账号安全", exact: true }).click();
    await page.getByRole("button", { name: "退出 EasyEmail 与 NAccount 全站登录", exact: true }).click();
    await page.getByRole("link", { name: "Complete SSO logout" }).click();
    await page.getByRole("button", { name: "使用 NAccount 登录", exact: true }).waitFor();
    assert.equal(page.url(), `${f.h.appOrigin}/`);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);

    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: path.join(f.h.directory, "naccount-login-mobile.png"), fullPage: true });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await f.close();
  }
});
