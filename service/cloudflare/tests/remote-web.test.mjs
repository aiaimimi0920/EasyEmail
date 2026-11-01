import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { createHarness, INVITE, PASSWORD } from "./runtime-harness.mjs";
import { remoteFixture } from "./remote-fixture.mjs";

test("Chrome: typed confirmation/cancel, unknown restoration, read-only reconcile and remote-delete permission", { timeout: 90000 }, async () => {
  const f = await remoteFixture(); let h, browser, page;
  try {
    h = await createHarness(f.bindings, true);
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); page.setDefaultTimeout(10000);
    const errors = [], external = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => { if (!request.url().startsWith(h.baseUrl.origin)) external.push(request.url()); });
    await page.goto(h.baseUrl.href);
    await page.getByRole("button", { name: "使用邀请口令注册", exact: true }).click();
    await page.getByLabel("用户名", { exact: true }).fill("remote-web-alice");
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await page.getByLabel("邀请口令", { exact: true }).fill(INVITE);
    await page.getByRole("button", { name: "注册", exact: true }).click();
    await page.getByRole("combobox", { name: "域名", exact: true }).selectOption("cf.example.test");
    await page.getByRole("button", { name: "分配随机邮箱", exact: true }).click();
    await page.getByRole("heading", { name: "收件箱", exact: true }).waitFor();
    const box = await h.db.prepare("SELECT * FROM mailboxes LIMIT 1").first();
    const mail = await f.seed(box.address, 77, { subject: "Synthetic remote deletion acceptance" });
    await page.getByRole("button", { name: "刷新收信", exact: true }).click();
    await page.getByRole("button", { name: mail.subject, exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "删除上游邮件", exact: true }).count(), 0);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "移到平台回收站", exact: true }).click();
    await page.getByRole("article", { name: "邮件详情" }).waitFor({ state: "detached" });
    async function openTrash() {
      await page.getByRole("button", { name: "聚合收件箱", exact: true }).click();
      await page.getByRole("combobox", { name: "邮件来源", exact: true }).selectOption("temporary");
      await page.getByRole("combobox", { name: "文件夹", exact: true }).selectOption("trash");
      await page.getByRole("button", { name: "搜索邮件", exact: true }).click();
      await page.getByRole("button", { name: mail.subject, exact: true }).click();
    }
    await openTrash(); await page.getByRole("button", { name: "删除上游邮件", exact: true }).click();
    await page.getByLabel("确认远端删除的邮箱地址", { exact: true }).fill("wrong@example.test");
    assert.equal(await page.getByRole("button", { name: "确认删除上游邮件", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "取消远端删除", exact: true }).click();
    assert.equal(f.calls.some((call) => call.path === "/cf/api/mail_deletions"), false);
    await page.getByRole("button", { name: "删除上游邮件", exact: true }).click();
    await page.getByLabel("确认远端删除的邮箱地址", { exact: true }).fill(box.address);
    f.modes.set("/cf/api/mail_deletions", "lose-response");
    await page.getByRole("button", { name: "确认删除上游邮件", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "远端删除结果未知" }).waitFor();
    assert.equal(await f.db.prepare("SELECT id FROM raw_mails WHERE id=77").first(), null);
    await page.reload(); await openTrash();
    await page.getByRole("status").filter({ hasText: "远端删除结果未知" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "删除上游邮件", exact: true }).count(), 0);
    await page.getByRole("button", { name: "核对远端结果", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "源邮件已删除；平台缓存保留" }).waitFor();
    assert.equal(f.calls.filter((call) => call.path === "/cf/api/mail_deletions" && call.method === "POST").length, 1);
    assert.ok(await page.getByText("Your verification code is 485723.", { exact: true }).count());
    await page.getByRole("combobox", { name: "权限", exact: true }).selectOption("remote-delete");
    await page.getByLabel("名称", { exact: true }).fill("conditional remote cleaner");
    await page.getByRole("button", { name: "创建 Key", exact: true }).click(); await page.getByTestId("new-key").waitFor();
    assert.deepEqual(JSON.parse((await h.db.prepare("SELECT scopes FROM api_keys LIMIT 1").first()).scopes),
      ["mailboxes:read", "messages:read", "messages:remote-delete"]);
    await page.getByRole("button", { name: "隐藏", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(h.directory, "remote-delete-mobile.png"), fullPage: true });
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    console.log(`M3j Chrome evidence: ${h.directory}`);
  } catch (error) {
    if (page) { console.error(await page.locator("body").ariaSnapshot()); await page.screenshot({ path: path.join(h.directory, "remote-failure.png"), fullPage: true }); }
    throw error;
  } finally { await browser?.close(); await h?.close(); await f.close(); }
});
