import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { normalFoldersFixture } from "./normal-folders-fixture.mjs";
import { PASSWORD } from "./runtime-harness.mjs";

const button = (page, name) => page.getByRole("button", { name, exact: true });
test("Chrome: directory discovery is explicit, cached reads do not connect, and lost POST response is recovered without another LIST", { timeout: 90000 }, async () => {
  const t = await normalFoldersFixture({ browser: true }); let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [], external = []; page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (!request.url().startsWith(t.h.baseUrl.origin)) external.push(request.url()); });
    await page.goto(t.h.baseUrl.href); await page.getByLabel("用户名", { exact: true }).fill(t.alice.username);
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await button(page, "登录").click();
    await button(page.getByRole("navigation"), "普通邮箱").click();
    const region = page.getByRole("region", { name: "普通邮箱", exact: true }); await button(region, "普通邮箱").click();
    const catalog = region.getByRole("region", { name: "服务器文件夹", exact: true });
    await catalog.getByText("暂无当前来源目录", { exact: true }).waitFor(); assert.equal(t.opens.length, 0);
    await page.route(`**${t.path}/discover`, async route => { await route.fetch(); await route.abort("connectionfailed"); });
    await button(catalog, "发现服务器文件夹").click(); await catalog.getByRole("alert").waitFor();
    assert.equal(t.opens.length, 1); await button(catalog, "刷新缓存目录").click();
    await catalog.getByText("中文", { exact: true }).waitFor(); assert.equal(t.opens.length, 1);
    assert.equal(await catalog.getByRole("listitem").count(), 5);
    await button(page.getByRole("navigation"), "联系人").click(); await button(page.getByRole("navigation"), "普通邮箱").click();
    await catalog.getByText("中文", { exact: true }).waitFor(); assert.equal(t.opens.length, 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    assert.equal(t.calls.some(line => /SELECT|EXAMINE|FETCH|STORE|EXPUNGE/.test(line)), false);
    await page.screenshot({ path: path.join(t.h.directory, "server-folders-mobile.png"), fullPage: true });
    console.log(`Server folders Chrome evidence: ${t.h.directory}`);
  } finally { try { await browser?.close(); } finally { await t.close(); } }
});
