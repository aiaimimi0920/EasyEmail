import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { normalAccessFixture } from "./normal-access-fixture.mjs";
import { ATTACHMENT, multipartMessage } from "./normal-mime-fixture.mjs";
import { PASSWORD } from "./runtime-harness.mjs";

test("Chrome: public normal receive, inert HTML, exact binary downloads, restart reading and original sync reconciliation", { timeout: 240000 }, async () => {
  const raw = multipartMessage(), t = await normalAccessFixture({ browser: true, messages: new Map([[1, raw]]), uidNext: 2 });
  let browser, page;
  try {
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); page.setDefaultTimeout(15000);
    const errors = [], external = []; page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (!request.url().startsWith(t.h.baseUrl.origin)) external.push(request.url()); });
    await page.goto(t.h.baseUrl.href); await page.getByLabel("用户名", { exact: true }).fill(t.alice.username);
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByRole("navigation").getByRole("button", { name: "普通邮箱", exact: true }).click();
    const region = page.getByRole("region", { name: "普通邮箱", exact: true });
    await region.getByRole("button", { name: "普通邮箱", exact: true }).click();
    const keys = [];
    await page.route(`**/api/v1/normal-accounts/${t.id}/sync`, async route => {
      keys.push(route.request().headers()["idempotency-key"]); await route.fetch(); await route.abort("failed");
    });
    await region.getByRole("button", { name: "同步普通邮箱", exact: true }).click();
    await region.getByRole("button", { name: "核对本次同步", exact: true }).waitFor();
    assert.equal(await region.getByRole("button", { name: "移除普通邮箱", exact: true }).isDisabled(), true);
    await page.getByRole("navigation").getByRole("button", { name: "联系人", exact: true }).click();
    await page.getByRole("navigation").getByRole("button", { name: "普通邮箱", exact: true }).click();
    await region.getByRole("button", { name: "核对本次同步", exact: true }).click();
    await region.getByRole("status").filter({ hasText: "本批保存 1 封" }).waitFor();
    assert.equal(keys.length, 1); assert.equal(t.opens.length, 1);
    await region.getByRole("button", { name: "attachments", exact: true }).click();
    const detail = region.getByRole("region", { name: "普通邮件详情" });
    assert.match(await detail.getByTestId("mail-body").textContent(), /纯文本/); assert.equal(await page.locator("iframe").count(), 0);
    await detail.getByRole("button", { name: "安全 HTML", exact: true }).click();
    const frame = page.frameLocator('iframe[title="安全邮件正文"]'); await frame.getByText("HTML", { exact: true }).waitFor();
    assert.equal(await frame.locator("script, img, a[href], iframe, form").count(), 0);
    for (const [button, expected, filename] of [["下载 part-0.bin", ATTACHMENT, "normal-attachment.bin"], ["下载原始邮件", raw, "normal-raw.eml"]]) {
      const event = page.waitForEvent("download"); await detail.getByRole("button", { name: button, exact: true }).click();
      const download = await event, target = path.join(t.h.directory, filename); await download.saveAs(target);
      assert.deepEqual(await readFile(target), Buffer.from(expected));
    }
    await page.reload(); await page.getByRole("navigation").getByRole("button", { name: "普通邮箱", exact: true }).click();
    await region.getByRole("button", { name: "普通邮箱", exact: true }).click(); await region.getByRole("button", { name: "attachments", exact: true }).waitFor();
    assert.equal(t.opens.length, 1, "read and reload do not automatically reconnect");
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(t.h.directory, "normal-access-mobile.png"), fullPage: true });
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0); assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log(`Normal receive Chrome evidence: ${t.h.directory}`);
  } catch (error) {
    if (page) { console.error(await page.locator("body").ariaSnapshot()); await page.screenshot({ path: path.join(t.h.directory, "normal-access-failure.png"), fullPage: true }); }
    throw error;
  } finally { await browser?.close(); await t.close(); }
});
