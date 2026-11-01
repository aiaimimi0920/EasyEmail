import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { mailboxDeleteFixture } from "./mailbox-delete-fixture.mjs";
import { PASSWORD } from "./runtime-harness.mjs";

test("Chrome: mailbox confirmation/cancel, persistent unknown, read-only check and lost HTTP response never dispatch a second delete", { timeout: 90000 }, async () => {
  const t = await mailboxDeleteFixture(true); let browser, page;
  try {
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); page.setDefaultTimeout(10000);
    const errors = [], external = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => { if (!request.url().startsWith(t.h.baseUrl.origin)) external.push(request.url()); });
    await page.goto(t.h.baseUrl.href);
    await page.getByLabel("用户名", { exact: true }).fill(t.alice.username);
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByRole("combobox", { name: "域名", exact: true }).selectOption("cf.example.test");
    await page.getByRole("button", { name: "分配随机邮箱", exact: true }).click();
    await page.getByRole("heading", { name: "收件箱", exact: true }).waitFor();
    const box = await t.h.db.prepare("SELECT * FROM mailboxes LIMIT 1").first();
    await page.getByRole("button", { name: "删除上游邮箱", exact: true }).click();
    await page.getByLabel("确认删除上游邮箱的地址", { exact: true }).fill("wrong@example.test");
    assert.equal(await page.getByRole("button", { name: "确认删除上游邮箱", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "取消删除上游邮箱", exact: true }).click();
    assert.equal(t.writes().length, 0);
    await page.getByRole("button", { name: "删除上游邮箱", exact: true }).click();
    await page.getByLabel("确认删除上游邮箱的地址", { exact: true }).fill(box.address);
    t.f.modes.set("/cf/api/address_deletions", "lose-response");
    await page.getByRole("button", { name: "确认删除上游邮箱", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "远端邮箱删除结果未知" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "删除上游邮箱", exact: true }).count(), 0);
    assert.equal(await t.f.db.prepare("SELECT id FROM address WHERE name=?").bind(box.address).first(), null);
    await page.reload(); await page.getByRole("button", { name: box.address, exact: true }).click();
    await page.getByRole("status").filter({ hasText: "远端邮箱删除结果未知" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "删除上游邮箱", exact: true }).count(), 0);
    await page.getByRole("button", { name: "核对远端邮箱结果", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "上游邮箱的 D1 数据已删除；平台缓存保留" }).waitFor();
    await page.getByRole("status").filter({ hasText: "已释放平台访问；历史缓存保留" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "刷新收信", exact: true }).isDisabled(), true);
    assert.equal(t.writes().length, 1);
    t.f.modes.clear(); const second = await t.sample();
    await page.reload(); await page.getByRole("button", { name: second.box.address, exact: true }).click();
    await page.route(`**/api/v1/mailboxes/${second.box.id}/remote-delete`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.fetch(); await route.abort("connectionreset");
    });
    await page.getByRole("button", { name: "删除上游邮箱", exact: true }).click();
    await page.getByLabel("确认删除上游邮箱的地址", { exact: true }).fill(second.box.address);
    await page.getByRole("button", { name: "确认删除上游邮箱", exact: true }).click();
    await page.getByRole("button", { name: "刷新远端邮箱删除记录", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "确认删除上游邮箱", exact: true }).count(), 0);
    await page.getByRole("button", { name: "刷新远端邮箱删除记录", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "上游邮箱的 D1 数据已删除；平台缓存保留" }).waitFor();
    assert.equal(t.writes().length, 2);
    await page.getByRole("combobox", { name: "权限", exact: true }).selectOption("mailbox-remote-delete");
    await page.getByLabel("名称", { exact: true }).fill("conditional mailbox cleaner");
    await page.getByRole("button", { name: "创建 Key", exact: true }).click(); await page.getByTestId("new-key").waitFor();
    assert.deepEqual(JSON.parse((await t.h.db.prepare("SELECT scopes FROM api_keys LIMIT 1").first()).scopes), ["mailboxes:read", "mailboxes:remote-delete"]);
    await page.getByRole("button", { name: "隐藏", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(t.h.directory, "mailbox-delete-mobile.png"), fullPage: true });
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    console.log(`M3k Chrome evidence: ${t.h.directory}`);
  } catch (error) {
    if (page) { console.error(await page.locator("body").ariaSnapshot()); await page.screenshot({ path: path.join(t.h.directory, "mailbox-delete-failure.png"), fullPage: true }); }
    throw error;
  } finally { await browser?.close(); await t.close(); }
});
