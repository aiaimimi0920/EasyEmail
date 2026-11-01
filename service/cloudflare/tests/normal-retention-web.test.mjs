import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { PASSWORD } from "./runtime-harness.mjs";
import { normalRetentionFixture } from "./normal-retention-fixture.mjs";

test("Chrome: ordinary cache preview, explicit confirmation, lost-response reconciliation and truthful pending object status", { timeout: 90000 }, async () => {
  const t = await normalRetentionFixture({ browser: true, testEntry: "./normal-retention-test-worker.ts" }); let browser, page;
  try {
    const { rows: [source] } = await t.receive(); await t.age(source.id); await t.policy({ enabled: true, cacheDays: 1 });
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); page.setDefaultTimeout(10000);
    const errors = [], external = [], keys = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (!request.url().startsWith(t.h.baseUrl.origin)) external.push(request.url()); });
    await page.goto(t.h.baseUrl.href); await page.getByLabel("用户名", { exact: true }).fill(t.alice.username);
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByRole("button", { name: "平台管理", exact: true }).click();
    const panel = page.getByRole("region", { name: "数据保留", exact: true });
    await panel.getByRole("button", { name: "预览保留影响", exact: true }).click();
    const preview = panel.getByRole("region", { name: "保留预览", exact: true });
    await preview.getByText("普通邮箱缓存", { exact: true }).waitFor();
    assert.equal(await preview.locator("dl > div").filter({ has: page.getByText("普通邮箱缓存", { exact: true }) }).locator("dd").innerText(), "1");
    page.once("dialog", dialog => dialog.dismiss()); await panel.getByRole("button", { name: "执行一批维护", exact: true }).click();
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM retention_runs").first("n"), 0);
    await page.route("**/admin/retention/run", async route => {
      keys.push(route.request().headers()["idempotency-key"]);
      if (keys.length === 1) { await route.fetch({ headers: { ...route.request().headers(), "x-test-retention-delete-fail": "1" } }); return route.abort("failed"); }
      return route.continue();
    });
    page.once("dialog", dialog => dialog.accept()); await panel.getByRole("button", { name: "执行一批维护", exact: true }).click();
    await panel.getByRole("status").filter({ hasText: "维护结果待确认" }).waitFor();
    await page.getByRole("button", { name: "聚合收件箱", exact: true }).click();
    await page.getByRole("button", { name: "平台管理", exact: true }).click();
    await panel.getByRole("button", { name: "检查维护结果", exact: true }).click();
    await panel.getByRole("status").filter({ hasText: "未再执行一批" }).waitFor();
    await panel.getByRole("status").filter({ hasText: "普通对象待确认回收：2" }).waitFor();
    assert.equal(new Set(keys).size, 1); assert.equal(keys.length, 2);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM retention_runs").first("n"), 1);
    await t.h.request("/__test/normal-cleanup"); await panel.getByRole("button", { name: "刷新保留策略", exact: true }).click();
    await panel.getByRole("status").filter({ hasText: "普通对象待确认回收：0" }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(t.h.directory, "normal-retention-mobile.png"), fullPage: true });
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0); assert.deepEqual(errors, []); assert.deepEqual(external, []);
  } catch (error) { if (page) console.error(await page.locator("body").ariaSnapshot()); throw error; }
  finally { await browser?.close(); await t.close(); }
});
