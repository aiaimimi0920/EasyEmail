import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { folderReplyFixture } from "./normal-folder-reply-fixture.mjs";
import { PASSWORD } from "./runtime-harness.mjs";
import { assetBytes } from "./outbox-fixture.mjs";

const button = (root, name) => root.getByRole("button", { name, exact: true });
async function open(t) {
  const browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); page.setDefaultTimeout(15000);
  try {
    await page.goto(t.h.baseUrl.href); await page.getByLabel("用户名", { exact: true }).fill(t.alice.username);
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await button(page, "登录").click();
    await button(page.getByRole("navigation"), "普通邮箱").click();
    const normal = page.getByRole("region", { name: "普通邮箱", exact: true }); await button(normal, "普通发信邮箱").click();
    const send = normal.getByRole("region", { name: "普通邮箱发信", exact: true }); await send.getByLabel("普通邮件正文", { exact: true }).waitFor();
    return { browser, page, normal, send };
  } catch (error) { await browser.close(); throw error; }
}
async function aggregate(ui) {
  await button(ui.page.getByRole("navigation"), "聚合收件箱").click();
  const inbox = ui.page.getByRole("region", { name: "聚合邮件", exact: true }); await button(inbox, "Reply acceptance").click();
  return inbox.getByRole("region", { name: "普通邮件详情", exact: true });
}

test("Chrome: directory reply reuses composer, attachment/draft reopen and read-only original-send reconciliation", { timeout: 120000 }, async () => {
  const t = await folderReplyFixture(true); let ui;
  try {
    await t.configure(); const source = await t.seedFolder(); ui = await open(t); const { page, normal, send } = ui, previews = [], posts = [], reads = [], errors = [], external = [];
    page.on("pageerror", error => errors.push(error.message)); page.on("request", request => { if (!request.url().startsWith(t.h.baseUrl.origin)) external.push(request.url()); });
    await page.route(`**${source.path}/reply`, route => { previews.push(route.request().url()); return route.continue(); });
    const catalog = normal.getByRole("region", { name: "服务器文件夹", exact: true }); await button(catalog, "查看 Archive 邮件").click();
    await button(catalog, "Reply acceptance").click(); const detail = catalog.getByRole("region", { name: "普通邮件详情", exact: true });
    await button(detail, "服务器加星标").waitFor(); await button(detail, "回复").click();
    await send.getByText(`回复原邮件 ${source.id}`, { exact: true }).waitFor();
    assert.equal(await send.getByLabel("收件地址", { exact: true }).inputValue(), "archive@example.test");
    await send.getByLabel("普通邮件正文", { exact: true }).fill("目录网页回复正文");
    await send.getByLabel("添加发送附件", { exact: true }).setInputFiles({ name: "folder.bin", mimeType: "application/octet-stream", buffer: Buffer.from(assetBytes) });
    await send.getByText("folder.bin", { exact: true }).waitFor(); await button(send, "保存普通邮箱云端草稿").click();
    await send.getByRole("status").filter({ hasText: "已保存到云端 · 版本 1" }).waitFor(); await button(send, "新建普通邮件").click();
    await send.getByRole("region", { name: "普通邮箱云端草稿", exact: true }).getByRole("button", { name: "Re: Reply acceptance", exact: true }).click();
    await send.getByText(`回复原邮件 ${source.id}`, { exact: true }).waitFor();
    await page.route(`**${t.path}/send`, async route => { posts.push(route.request().postDataJSON()); await route.fetch(); await route.abort("failed"); });
    await page.route(`**${t.path}/outgoing?requestKey=*`, route => { reads.push(route.request().url()); return route.continue(); });
    await button(send, "发送普通邮件").click(); await button(send, "核对原普通邮件发送").waitFor();
    await button(await aggregate(ui), "回复").click(); await page.getByRole("alert").filter({ hasText: "请先处理普通邮箱的未决操作或未保存内容" }).waitFor();
    await button(page.getByRole("navigation"), "普通邮箱").click(); await button(send, "核对原普通邮件发送").click();
    await send.getByRole("status").filter({ hasText: "此普通草稿已提交发送" }).waitFor();
    assert.equal(previews.length, 1); assert.equal(posts.length, 1); assert.equal(posts[0].replyToMessageId, source.id); assert.equal(posts[0].attachments.length, 1);
    assert.equal(reads.length, 1); assert.equal(t.messages.length, 1); assert.match(t.messages[0], /In-Reply-To: <archive@example.test>/);
    assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(t.h.directory, "folder-reply-mobile.png"), fullPage: true }); console.log(`Folder reply Chrome evidence: ${t.h.directory}`);
  } catch (error) { if (ui) console.error(await ui.page.locator("body").ariaSnapshot()); throw error; }
  finally { await ui?.browser.close(); await t.close(); }
});

test("Chrome: aggregate folder reply rejects mismatched preview identity and cannot overwrite input changed while preview is delayed", { timeout: 90000 }, async () => {
  const t = await folderReplyFixture(true); let ui, release;
  try {
    await t.configure(); const source = await t.seedFolder(); ui = await open(t); const { page, send } = ui;
    const detail = await aggregate(ui);
    await page.route(`**${source.path}/reply`, async route => {
      const response = await route.fetch(), body = await response.json(); body.reply.serverFolderId = "0".repeat(64); await route.fulfill({ response, json: body });
    });
    await button(detail, "回复").click(); await page.getByRole("alert").filter({ hasText: "连接失败" }).waitFor();
    await button(page.getByRole("navigation"), "普通邮箱").click();
    assert.equal(await send.getByText(/^回复原邮件 /).count(), 0); assert.equal(await send.getByLabel("收件地址", { exact: true }).inputValue(), "");
    await page.unroute(`**${source.path}/reply`);
    let entered; const entering = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    await page.route(`**${source.path}/reply`, async route => { const response = await route.fetch(); entered(); await gate; await route.fulfill({ response }); });
    await button(page.getByRole("navigation"), "聚合收件箱").click();
    await button(detail, "回复").click(); await entering; await button(page.getByRole("navigation"), "普通邮箱").click();
    await send.getByLabel("普通邮件主题", { exact: true }).fill("必须保留的未保存主题"); release();
    await page.getByRole("alert").filter({ hasText: "请先处理普通邮箱的未决操作或未保存内容" }).waitFor();
    assert.equal(await send.getByLabel("普通邮件主题", { exact: true }).inputValue(), "必须保留的未保存主题");
    assert.equal(await send.getByText(/^回复原邮件 /).count(), 0); assert.equal(t.opens.length, 0);
  } finally { release?.(); await ui?.browser.close(); await t.close(); }
});
