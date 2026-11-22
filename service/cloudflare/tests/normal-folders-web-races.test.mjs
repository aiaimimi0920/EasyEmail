import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { normalFoldersFixture } from "./normal-folders-fixture.mjs";
import { PASSWORD } from "./runtime-harness.mjs";

const button = (page, name) => page.getByRole("button", { name, exact: true });
for (const outcome of ["late-cache", "late-error", "early-error"]) test(`Chrome: navigation ${outcome} cannot replace a freshly discovered directory or leave a stale error`, { timeout: 90000 }, async () => {
  const t = await normalFoldersFixture({ browser: true }); let browser, gate, release;
  try {
    assert.equal((await t.discover()).status, 200);
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    const page = await browser.newPage();
    await page.goto(t.h.baseUrl.href); await page.getByLabel("用户名", { exact: true }).fill(t.alice.username);
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await button(page, "登录").click();
    const nav = page.getByRole("navigation"); await button(nav, "普通邮箱").click();
    const account = page.getByRole("region", { name: "普通邮箱", exact: true }); await button(account, "普通邮箱").click();
    const catalog = account.getByRole("region", { name: "服务器文件夹", exact: true }); await catalog.getByText("中文", { exact: true }).waitFor();
    gate = t.holdCommand(/ LIST /); await button(catalog, "发现服务器文件夹").click(); await gate.entered;
    let captured, settled;
    const capturedPromise = new Promise(resolve => { captured = resolve; });
    const released = new Promise(resolve => { release = resolve; });
    const settledPromise = new Promise(resolve => { settled = resolve; });
    await page.route(`**${t.path}`, async route => {
      const response = await route.fetch(), text = await response.text(); captured(); await released;
      try { await route.fulfill({ status: outcome === "late-cache" ? response.status() : 503,
        contentType: "application/json", body: outcome === "late-cache" ? text : JSON.stringify({ error: "normal_folder_storage_unknown" }) }); } finally { settled(); }
    });
    await button(nav, "联系人").click(); await button(nav, "普通邮箱").click(); await capturedPromise;
    if (outcome === "early-error") { release(); release = null; await settledPromise; await catalog.getByRole("alert").waitFor(); }
    t.scenario({ rows: ['* LIST () "/" INBOX\r\n', '* LIST (\\Sent) "/" FreshDirectory\r\n'] });
    gate.release(); gate = null; await catalog.getByText("FreshDirectory", { exact: true }).waitFor();
    await catalog.getByRole("status").filter({ hasText: "已更新 2 个服务器文件夹" }).waitFor();
    assert.equal(await button(catalog, "发现服务器文件夹").isEnabled(), true);
    assert.equal(await button(catalog, "刷新缓存目录").isEnabled(), true);
    release?.(); release = null; await settledPromise;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await catalog.getByText("FreshDirectory", { exact: true }).count(), 1);
    assert.equal(await catalog.getByRole("listitem").count(), 2);
    assert.equal(await catalog.getByRole("alert").count(), 0);
    const snapshot = (await t.cached()).body.catalog; assert.equal(snapshot.items.length, 2);
  } finally { release?.(); gate?.release(); try { await browser?.close(); } finally { await t.close(); } }
});

test("Chrome: failed discovery invalidates navigation GET and releases both busy states", { timeout: 90000 }, async () => {
  const t = await normalFoldersFixture({ browser: true }); let browser, gate, release;
  try {
    assert.equal((await t.discover()).status, 200);
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    const page = await browser.newPage();
    await page.goto(t.h.baseUrl.href); await page.getByLabel("用户名", { exact: true }).fill(t.alice.username);
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await button(page, "登录").click();
    const nav = page.getByRole("navigation"); await button(nav, "普通邮箱").click();
    const account = page.getByRole("region", { name: "普通邮箱", exact: true }); await button(account, "普通邮箱").click();
    const catalog = account.getByRole("region", { name: "服务器文件夹", exact: true }); await catalog.getByText("中文", { exact: true }).waitFor();
    gate = t.holdCommand(/ LIST /); await button(catalog, "发现服务器文件夹").click(); await gate.entered;
    let captured, settled;
    const capturedPromise = new Promise(resolve => { captured = resolve; }), settledPromise = new Promise(resolve => { settled = resolve; });
    const released = new Promise(resolve => { release = resolve; });
    await page.route(`**${t.path}`, async route => {
      await route.fetch(); captured(); await released;
      try { await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "normal_folder_storage_unknown" }) }); } finally { settled(); }
    });
    await button(nav, "联系人").click(); await button(nav, "普通邮箱").click(); await capturedPromise;
    t.scenario({ rows: ['* LIST () "/" "&broken-"\r\n'] }); gate.release(); gate = null;
    await catalog.getByRole("alert").filter({ hasText: "服务器文件夹名称不符合" }).waitFor();
    assert.equal(await button(catalog, "发现服务器文件夹").isEnabled(), true);
    assert.equal(await button(catalog, "刷新缓存目录").isEnabled(), true);
    release(); release = null; await settledPromise;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.match(await catalog.getByRole("alert").textContent(), /服务器文件夹名称不符合/);
    assert.equal(await catalog.getByText("中文", { exact: true }).count(), 1); assert.equal(t.opens.length, 2);
  } finally { release?.(); gate?.release(); try { await browser?.close(); } finally { await t.close(); } }
});
