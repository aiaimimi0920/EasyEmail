import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { normalFolderInboxFixture } from "./normal-folder-inbox-fixture.mjs";
import { PASSWORD } from "./runtime-harness.mjs";

const button = (scope, name) => scope.getByRole("button", { name, exact: true });
async function login(t, page) {
  await page.goto(t.h.baseUrl.href); await page.getByLabel("用户名", { exact: true }).fill(t.alice.username);
  await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await button(page, "登录").click();
  await button(page.getByRole("navigation"), "普通邮箱").click();
  const account = page.getByRole("region", { name: "普通邮箱", exact: true }); await button(account, "普通邮箱").click();
  const catalog = account.getByRole("region", { name: "服务器文件夹", exact: true });
  await catalog.getByText("中文", { exact: true }).waitFor(); return catalog;
}
test("Chrome: explicit folder sync, unknown POST reconciliation, navigation and isolated cached raw download", { timeout: 90000 }, async () => {
  const t = await normalFolderInboxFixture({ browser: true }); let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } }), errors = [], external = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (!request.url().startsWith(t.h.baseUrl.origin)) external.push(request.url()); });
    const catalog = await login(t, page), opens = t.opens.length;
    await button(catalog, "查看 Sent 邮件").click();
    const inbox = catalog.getByRole("region", { name: "服务器文件夹邮件", exact: true });
    await inbox.getByText("暂无缓存邮件", { exact: true }).waitFor(); assert.equal(t.opens.length, opens);
    let syncs = 0;
    await page.route(`**${t.folderPath("Sent")}/sync`, async route => { syncs++; await route.fetch(); await route.abort("connectionfailed"); });
    await button(inbox, "同步此文件夹").click(); await button(inbox, "核对文件夹同步").waitFor();
    assert.equal(t.opens.length, opens + 1); assert.equal(await button(catalog, "查看 中文 邮件").isDisabled(), true);
    await button(page.getByRole("navigation"), "联系人").click(); await button(page.getByRole("navigation"), "普通邮箱").click();
    await button(inbox, "核对文件夹同步").click(); await button(inbox, "Sent mail").waitFor();
    assert.equal(syncs, 1); assert.equal(t.opens.length, opens + 1);
    await button(inbox, "Sent mail").click();
    const detail = inbox.getByRole("region", { name: "服务器文件夹邮件详情", exact: true });
    await detail.getByText("Sent mail body", { exact: true }).waitFor();
    assert.match(await detail.textContent(), /bob@example.test/);
    assert.equal(await button(detail, "服务器加星标").count(), 1);
    assert.equal(await button(detail, "回复").count(), 1);
    assert.equal(await button(detail, "归档").count(), 1);
    const downloadPromise = page.waitForEvent("download"); await button(detail, "下载原始邮件").click();
    const download = await downloadPromise, file = path.join(t.h.directory, "folder-sent.eml"); await download.saveAs(file);
    assert.match(await readFile(file, "utf8"), /To: bob@example.test/);
    await page.screenshot({ path: path.join(t.h.directory, "folder-inbox-mobile.png"), fullPage: true });
    await button(catalog, "查看 中文 邮件").click(); await inbox.getByText("暂无缓存邮件", { exact: true }).waitFor();
    assert.equal(await detail.count(), 0); assert.equal(t.opens.length, opens + 1);
    await button(inbox, "同步此文件夹").click(); await button(inbox, "Archive mail").waitFor();
    assert.equal(await button(inbox, "Sent mail").count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    assert.equal(t.calls.some(line => / SELECT | STORE | MOVE | EXPUNGE/.test(line)), false);
    console.log(`Folder inbox Chrome evidence: ${t.h.directory}`);
  } finally { try { await browser?.close(); } finally { await t.close(); } }
});

test("Chrome: a late cached Sent response cannot overwrite a newly selected folder", { timeout: 90000 }, async () => {
  const t = await normalFolderInboxFixture({ browser: true }); let browser, release;
  try {
    await t.receive("Sent"); await t.receive("&Ti1lhw-");
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    const page = await browser.newPage(), catalog = await login(t, page);
    let captured, settled; const capturedPromise = new Promise(resolve => { captured = resolve; });
    const waiting = new Promise(resolve => { release = resolve; }), settledPromise = new Promise(resolve => { settled = resolve; });
    await page.route(`**${t.folderPath("Sent")}/messages?*`, async route => {
      const response = await route.fetch(); captured(); await waiting;
      try { await route.fulfill({ response }); } finally { settled(); }
    });
    await button(catalog, "查看 Sent 邮件").click(); await capturedPromise;
    await button(catalog, "查看 中文 邮件").click();
    const inbox = catalog.getByRole("region", { name: "服务器文件夹邮件", exact: true }); await button(inbox, "Archive mail").waitFor();
    release(); release = null; await settledPromise;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await button(inbox, "Sent mail").count(), 0); assert.equal(await button(inbox, "Archive mail").count(), 1);
  } finally { release?.(); try { await browser?.close(); } finally { await t.close(); } }
});
