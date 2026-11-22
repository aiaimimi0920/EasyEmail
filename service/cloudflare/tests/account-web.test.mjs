import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { createHarness, newKey, PASSWORD } from "./runtime-harness.mjs";
import { accountAction, ok } from "./account-fixture.mjs";

async function signIn(page, h, username, password = PASSWORD) {
  await page.goto(h.baseUrl.href);
  await page.getByLabel("用户名", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "退出登录", exact: true }).waitFor();
}

test("Chrome: account administration confirms/cancels, refreshes conflicts, blocks duplicate submission and self-revokes", { timeout: 60000 }, async () => {
  const h = await createHarness({}, true);
  let browser, release;
  try {
    const admin = await h.register("web-account-admin"), alice = await h.register("web-account-alice");
    await h.db.prepare("INSERT INTO platform_admins VALUES (?,unixepoch())").bind(admin.id).run();
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    const page = await browser.newPage(); page.setDefaultTimeout(10000);
    const errors = []; page.on("pageerror", (error) => errors.push(error.message));
    await signIn(page, h, admin.username);
    await page.getByRole("button", { name: "平台管理", exact: true }).click();
    const panel = page.getByRole("region", { name: "用户管理", exact: true });
    const disable = panel.getByRole("button", { name: `停用 ${alice.username}`, exact: true });
    await disable.click();
    const confirm = panel.getByRole("button", { name: "确认账号操作", exact: true });
    assert.equal(await confirm.isEnabled(), false);
    await panel.getByLabel("输入完整用户名确认").fill("wrong"); assert.equal(await confirm.isEnabled(), false);
    await panel.getByRole("button", { name: "取消账号操作", exact: true }).click();
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM account_audit").first()).n, 0);
    await disable.click();
    await panel.getByLabel("输入完整用户名确认").fill(alice.username);
    ok(await accountAction(h, admin, alice, "revoke-credentials"));
    await confirm.click();
    await panel.getByRole("alert").filter({ hasText: "账号状态已变化" }).waitFor();
    assert.equal(await panel.getByRole("form", { name: "确认账号操作" }).count(), 0);
    await disable.click(); await panel.getByLabel("输入完整用户名确认").fill(alice.username);
    let enter;
    const entered = new Promise((resolve) => { enter = resolve; });
    const held = new Promise((resolve) => { release = resolve; });
    await page.route(`**/api/v1/admin/users/${alice.id}/status`, async (route) => { enter(); await held; await route.continue(); });
    await confirm.click(); await entered;
    assert.equal(await confirm.isEnabled(), false); release();
    await panel.getByRole("button", { name: `启用 ${alice.username}`, exact: true }).waitFor();
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM account_audit WHERE action='disable'").first()).n, 1);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(h.directory, "account-admin-mobile.png"), fullPage: true });
    await panel.getByRole("button", { name: `撤销凭据 ${admin.username}`, exact: true }).click();
    await panel.getByLabel("输入完整用户名确认").fill(admin.username); await confirm.click();
    await page.getByRole("button", { name: "登录", exact: true }).waitFor();
    assert.equal(await page.getByRole("region", { name: "用户管理" }).count(), 0);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.deepEqual(errors, []);
  } finally { release?.(); await browser?.close(); await h.close(); }
});

test("Chrome: password change validates confirmation, clears account UI and Cookie and requires the new password", { timeout: 60000 }, async () => {
  const h = await createHarness({}, true);
  let browser;
  try {
    const user = await h.register("web-password-alice"), key = await newKey(h, user.cookie);
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    const page = await browser.newPage(); page.setDefaultTimeout(10000);
    await signIn(page, h, user.username);
    await page.getByRole("button", { name: "账号安全", exact: true }).click();
    const panel = page.getByRole("region", { name: "账号安全", exact: true });
    const next = "Browser-new-password-8472625";
    await panel.getByLabel("当前密码", { exact: true }).fill(PASSWORD);
    await panel.getByLabel("新密码", { exact: true }).fill(next);
    await panel.getByLabel("确认新密码", { exact: true }).fill("Browser-wrong-password-123");
    await panel.getByRole("button", { name: "修改密码并退出所有设备", exact: true }).click();
    await panel.getByRole("alert").filter({ hasText: "两次新密码不一致" }).waitFor();
    await panel.getByLabel("确认新密码", { exact: true }).fill(next);
    await panel.getByRole("button", { name: "修改密码并退出所有设备", exact: true }).click();
    await page.getByRole("button", { name: "登录", exact: true }).waitFor();
    assert.equal(await page.getByRole("region", { name: "账号安全" }).count(), 0);
    assert.equal((await page.context().cookies()).some((cookie) => cookie.name === "__Host-ee_session"), false);
    assert.equal((await h.request("/api/v1/me", { cookie: user.cookie })).status, 401);
    assert.equal((await h.request("/api/v1/me", { token: key.token })).status, 401);
    await signIn(page, h, user.username, next);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    await page.screenshot({ path: path.join(h.directory, "account-password-complete.png"), fullPage: true });
  } finally { await browser?.close(); await h.close(); }
});
