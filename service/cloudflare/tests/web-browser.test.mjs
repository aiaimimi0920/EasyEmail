import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { createHarness, INVITE, PASSWORD, seedMailbox } from "./runtime-harness.mjs";

test("Chrome: register, cookie login, owned mailbox, one-time API key, revoke, reload and logout", { timeout: 60000 }, async () => {
  const h = await createHarness({}, true);
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH
      ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error" && !message.text().includes("status of 401")) errors.push(message.text()); });
    await page.goto(h.baseUrl.href);
    await page.getByRole("button", { name: "使用邀请口令注册", exact: true }).click();
    await page.getByLabel("用户名", { exact: true }).fill("web-alice");
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD);
    await page.getByLabel("邀请口令", { exact: true }).fill(INVITE);
    await page.getByRole("button", { name: "注册", exact: true }).click();
    await page.getByRole("button", { name: "退出登录", exact: true }).waitFor();
    const user = await h.db.prepare("SELECT id FROM users WHERE username = 'web-alice'").first();
    await seedMailbox(h, user.id, "web-alice@example.test");
    const other = await h.register("web-bob");
    await seedMailbox(h, other.id, "web-bob@example.test");
    await page.reload();
    await page.getByText("web-alice@example.test", { exact: true }).waitFor();
    assert.equal(await page.getByText("web-bob@example.test", { exact: true }).count(), 0);
    const cookie = (await context.cookies()).find((value) => value.name === "__Host-ee_session");
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.secure, true);
    assert.equal(cookie.sameSite, "Strict");
    assert.equal(await page.evaluate(() => document.cookie), "");

    await page.getByRole("textbox", { name: "名称", exact: true }).fill("browser smoke");
    await page.getByRole("button", { name: "创建只读 Key", exact: true }).click();
    const secret = page.getByTestId("new-key");
    await secret.waitFor();
    const token = await secret.textContent();
    assert.match(token, /^ee_[a-f0-9]{64}$/);
    assert.equal((await h.request("/api/v1/mailboxes", { token })).status, 200);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    await page.reload();
    await page.getByText("browser smoke", { exact: true }).waitFor();
    assert.equal(await page.getByTestId("new-key").count(), 0);
    assert.equal((await page.locator("body").innerText()).includes(token), false);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await page.getByText("已撤销", { exact: true }).waitFor();
    assert.equal((await h.request("/api/v1/me", { token })).status, 401);
    await page.screenshot({ path: path.join(h.directory, "web-account.png"), fullPage: true });

    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await page.getByRole("button", { name: "登录", exact: true }).waitFor();
    await page.reload();
    await page.getByRole("button", { name: "登录", exact: true }).waitFor();
    await page.getByLabel("用户名", { exact: true }).fill("web-alice");
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByText("web-alice@example.test", { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: path.join(h.directory, "web-account-mobile.png"), fullPage: true });
    assert.deepEqual(errors, []);
    console.log(`Chrome Web evidence: ${h.directory}`);
  } finally {
    await browser?.close();
    await h.close();
  }
});
