import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { createHarness, INVITE, PASSWORD } from "./runtime-harness.mjs";
import { providerFixture } from "./provider-fixture.mjs";
import { attachmentMail, bytesHash } from "./attachment-fixture.mjs";

test("Chrome: inert HTML, explicit verified download, independent API permission and cancellation on navigation", { timeout: 90000 }, async () => {
  const f = await providerFixture();
  let h, browser, page;
  try {
    h = await createHarness(f.bindings, true);
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH
      ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    page = await browser.newPage({ viewport: { width: 1100, height: 1000 }, acceptDownloads: true });
    page.setDefaultTimeout(10000);
    const errors = [], external = [], downloads = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => { if (!request.url().startsWith(h.baseUrl.origin)) external.push(request.url()); });
    page.on("download", (download) => downloads.push(download));
    await page.goto(h.baseUrl.href);
    await page.getByRole("button", { name: "使用邀请口令注册", exact: true }).click();
    await page.getByLabel("用户名", { exact: true }).fill("content-web-alice");
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD);
    await page.getByLabel("邀请口令", { exact: true }).fill(INVITE);
    await page.getByRole("button", { name: "注册", exact: true }).click();
    await page.getByRole("combobox", { name: "域名", exact: true }).selectOption("cf.example.test");
    await page.getByRole("button", { name: "分配随机邮箱", exact: true }).click();
    await page.getByRole("heading", { name: "收件箱", exact: true }).waitFor();
    const box = await h.db.prepare("SELECT * FROM mailboxes LIMIT 1").first();
    const fixture = attachmentMail(box.address);
    fixture.parsed.subject = "HTML and attachment";
    fixture.parsed.html = `<h2>可读标题</h2><p><strong>保留排版</strong></p><table><tr><td>表格正文</td></tr></table>
      <script>parent.__mailExecuted = true; fetch('https://mail-tracker.invalid/script')</script>
      <style>@import 'https://mail-tracker.invalid/css'; body {background:url('https://mail-tracker.invalid/bg')}</style>
      <img src="https://mail-tracker.invalid/pixel" srcset="https://mail-tracker.invalid/srcset 2x" onerror="parent.__mailExecuted=true">
      <svg onload="parent.__mailExecuted=true"><image href="https://mail-tracker.invalid/svg" /></svg>
      <math><mtext><img src="https://mail-tracker.invalid/math"></mtext></math>
      <iframe src="https://mail-tracker.invalid/frame" srcdoc="<script>parent.__mailExecuted=true</script>"></iframe>
      <object data="https://mail-tracker.invalid/object"></object><embed src="https://mail-tracker.invalid/embed">
      <link rel="stylesheet" href="https://mail-tracker.invalid/link"><meta http-equiv="refresh" content="0;url=https://mail-tracker.invalid/refresh">
      <base href="https://mail-tracker.invalid/"><form action="https://mail-tracker.invalid/form"><input autofocus><button>提交恶意表单</button></form>
      <a href="javascript:parent.__mailExecuted=true" target="_top" ping="https://mail-tracker.invalid/ping">链接文字</a>
      <p style="background:url('https://mail-tracker.invalid/inline')" onclick="parent.__mailExecuted=true">无活动属性</p>`;
    f.messages.set(box.address, [fixture.parsed]); f.rawMails.set(box.address, [fixture.raw]);
    await page.getByRole("button", { name: "刷新收信", exact: true }).click();
    await page.getByRole("button", { name: fixture.parsed.subject, exact: true }).click();
    await page.getByTestId("mail-body").waitFor();
    const calls = f.calls.length;
    assert.equal(await page.locator("iframe").count(), 0, "HTML is opt-in");
    await page.getByRole("button", { name: "安全 HTML", exact: true }).click();
    const frame = page.frameLocator('iframe[title="安全邮件正文"]');
    await frame.getByRole("heading", { name: "可读标题" }).waitFor();
    assert.match(await frame.locator("body").textContent(), /保留排版/);
    assert.equal(await frame.locator("script,style,img,svg,math,iframe,object,embed,form,input,button,link,base").count(), 0);
    assert.equal(await frame.locator("[href],[src],[style],[onclick],[onload],[srcset],[target],[ping]").count(), 0);
    assert.equal(await page.locator("iframe").getAttribute("sandbox"), "");
    assert.equal(await page.evaluate(() => window.__mailExecuted), undefined);
    assert.equal(f.calls.length, calls, "HTML rendering must not fetch raw or sync mail");
    await page.getByRole("button", { name: "纯文本", exact: true }).click();
    assert.equal(await page.locator("iframe").count(), 0);

    const downloadButton = page.getByRole("button", { name: "下载 报告.txt", exact: true });
    await page.route("**/attachments/0", (route) => route.fulfill({ status: 409, contentType: "application/json",
      body: JSON.stringify({ error: { code: "attachment_source_changed" } }) }));
    await downloadButton.click();
    await page.getByRole("alert").filter({ hasText: "附件源已变化" }).waitFor();
    assert.equal(downloads.length, 0);
    await page.unroute("**/attachments/0");
    const received = page.waitForEvent("download");
    await downloadButton.click();
    const download = await received;
    assert.equal(download.suggestedFilename(), "报告.txt");
    const target = path.join(h.directory, "verified-attachment.bin");
    await download.saveAs(target);
    assert.equal(bytesHash(await readFile(target)), bytesHash(fixture.bytes));
    assert.equal(f.calls.length, calls + 1);

    await page.getByRole("combobox", { name: "权限", exact: true }).selectOption("attachments");
    await page.getByLabel("名称", { exact: true }).fill("verified-download-key");
    await page.getByRole("button", { name: "创建 Key", exact: true }).click();
    await page.getByTestId("new-key").waitFor();
    const key = await h.db.prepare("SELECT scopes FROM api_keys WHERE name = 'verified-download-key'").first();
    assert.deepEqual(JSON.parse(key.scopes), ["mailboxes:read", "messages:read", "attachments:read"]);

    const gate = f.hold("/cf/api/mail/71");
    try {
      await downloadButton.click(); await gate.entered;
      await page.getByRole("button", { name: "聚合收件箱", exact: true }).click();
      await page.getByRole("button", { name: fixture.parsed.subject, exact: true }).waitFor();
    } finally { gate.release(); }
    await page.getByRole("button", { name: fixture.parsed.subject, exact: true }).click();
    await page.getByRole("button", { name: "安全 HTML", exact: true }).click();
    await page.frameLocator('iframe[title="安全邮件正文"]').getByRole("heading", { name: "可读标题" }).waitFor();
    assert.equal(downloads.length, 1, "Leaving a message must not trigger a late background download");
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator("iframe").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(h.directory, "content-mobile.png"), fullPage: true });
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log(`M3c Chrome evidence: ${h.directory}`);
  } catch (error) {
    if (page) { console.error(await page.locator("body").ariaSnapshot()); await page.screenshot({ path: path.join(h.directory, "content-failure.png"), fullPage: true }); }
    throw error;
  } finally { await browser?.close(); await h?.close(); await f.close(); }
});
