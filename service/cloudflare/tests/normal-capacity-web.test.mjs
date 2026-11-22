import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { normalAccessFixture } from "./normal-access-fixture.mjs";
import { seedNormalSyncHistory, exhaustAdmission, syncRows } from "./normal-capacity-fixture.mjs";
import { PASSWORD } from "./runtime-harness.mjs";

test("Chrome: historical capacity does not block receive, admission 429 does not lock an uncreated intent, and lost success still reconciles the original key", { timeout: 90000 }, async () => {
  const t = await normalAccessFixture({ browser: true }); let browser, page;
  try {
    const first = await t.receive(); assert.equal(first.body.request.state, "committed");
    await seedNormalSyncHistory(t, first.body.request.result.batchId);
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); page.setDefaultTimeout(12000);
    const errors = [], external = [], keys = []; let lose = false;
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (!request.url().startsWith(t.h.baseUrl.origin)) external.push(request.url()); });
    await page.goto(t.h.baseUrl.href); await page.getByLabel("用户名", { exact: true }).fill(t.alice.username);
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByRole("navigation").getByRole("button", { name: "普通邮箱", exact: true }).click();
    const region = page.getByRole("region", { name: "普通邮箱", exact: true });
    await region.getByRole("button", { name: "普通邮箱", exact: true }).click();
    await page.route(`**/api/v1/normal-accounts/${t.id}/sync`, async route => {
      keys.push(route.request().headers()["idempotency-key"]);
      if (!lose) return route.continue();
      await route.fetch(); return route.abort("failed");
    });
    await exhaustAdmission(t.h, "normal-inbox-request", t.alice.id, 10);
    await region.getByRole("button", { name: "同步普通邮箱", exact: true }).click();
    await region.getByRole("alert").filter({ hasText: "操作过于频繁" }).waitFor();
    assert.equal(await region.getByRole("button", { name: "核对本次同步", exact: true }).count(), 0);
    assert.equal(await region.getByRole("button", { name: "移除普通邮箱", exact: true }).isDisabled(), false);
    assert.equal((await syncRows(t.h)).length, 1006); assert.equal(t.opens.length, 1); assert.equal(keys.length, 1);
    await t.h.resetLimits(); lose = true;
    await region.getByRole("button", { name: "同步普通邮箱", exact: true }).click();
    await region.getByRole("button", { name: "核对本次同步", exact: true }).waitFor();
    assert.equal(keys.length, 2); assert.notEqual(keys[0], keys[1]);
    assert.equal((await syncRows(t.h)).length, 1007); assert.equal(t.opens.length, 2);
    await exhaustAdmission(t.h, "normal-inbox-request", t.alice.id, 10);
    await region.getByRole("button", { name: "核对本次同步", exact: true }).click();
    await region.getByRole("status").filter({ hasText: "本批保存 0 封" }).waitFor();
    assert.equal(keys.length, 2); assert.equal(t.opens.length, 2);
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "移除普通邮箱" && !button.disabled));
    assert.equal(await region.getByRole("button", { name: "移除普通邮箱", exact: true }).isDisabled(), false);
    await page.screenshot({ path: path.join(t.h.directory, "normal-capacity.png"), fullPage: true });
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  } catch (error) { if (page) console.error(await page.locator("body").ariaSnapshot()); throw error; }
  finally { await browser?.close(); await t.close(); }
});
