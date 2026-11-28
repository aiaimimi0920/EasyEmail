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
      const trigger = detail.getByRole("button", { name: button, exact: true });
      await trigger.scrollIntoViewIfNeeded();
      // Settle the inner scroll surface before hit-testing beside a sandboxed iframe.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const [download] = await Promise.all([page.waitForEvent("download"), trigger.click()]);
      const target = path.join(t.h.directory, filename); await download.saveAs(target);
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

test("Chrome: NormalCachedMessage blocks remote images by default in fidelity mode and surfaces attachment error alerts", { timeout: 120000 }, async () => {
  const raw = new TextEncoder().encode([
    "From: Newsletter <news@example.test>",
    "To: alice@example.test",
    "Subject: remote-guard-check",
    "MIME-Version: 1.0",
    "Content-Type: multipart/mixed; boundary=parts",
    "",
    "--parts",
    "Content-Type: multipart/alternative; boundary=alt",
    "",
    "--alt",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "普通邮箱纯文本正文",
    "--alt",
    "Content-Type: text/html; charset=utf-8",
    "",
    '<p>HTML 富文本</p><img src="https://cdn.example.invalid/normal-banner.png" width="240" height="80" alt="NormalBanner"><img src="https://cdn.example.invalid/normal-unclosed.png" alt="unclosed><img src="https://track.example.invalid/pixel.gif" width="1" height="1">',
    "--alt--",
    "--parts",
    "Content-Type: application/octet-stream",
    'Content-Disposition: attachment; filename="part-0.bin"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(ATTACHMENT).toString("base64"),
    "--parts--",
    "",
  ].join("\r\n"));
  const t = await normalAccessFixture({ browser: true, messages: new Map([[1, raw]]), uidNext: 2 });
  let browser, page;
  try {
    browser = await chromium.launch({
      executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
      headless: true,
    });
    page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
    page.setDefaultTimeout(15000);
    const errors = [], cspErrors = [], external = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", msg => {
      if (msg.type() === "error" && /Content Security Policy/i.test(msg.text())) cspErrors.push(msg.text());
    });
    page.on("request", request => {
      const url = request.url();
      if (!url.startsWith(t.h.baseUrl.origin) && !url.startsWith("blob:") && !url.startsWith("data:")) external.push(url);
    });

    await page.goto(t.h.baseUrl.href);
    await page.getByLabel("用户名", { exact: true }).fill(t.alice.username);
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByRole("navigation").getByRole("button", { name: "普通邮箱", exact: true }).click();
    const region = page.getByRole("region", { name: "普通邮箱", exact: true });
    await region.getByRole("button", { name: "普通邮箱", exact: true }).click();
    await region.getByRole("button", { name: "同步普通邮箱", exact: true }).click();
    await region.getByRole("status").filter({ hasText: "本批保存 1 封" }).waitFor();

    await region.getByRole("button", { name: "remote-guard-check", exact: true }).click();
    const detail = region.getByRole("region", { name: "普通邮件详情" });
    assert.match(await detail.getByTestId("mail-body").textContent(), /普通邮箱纯文本正文/);
    assert.equal(await page.locator("iframe").count(), 0);

    await detail.getByRole("button", { name: "保真排版", exact: true }).click();
    await detail.getByRole("region", { name: "远程图片与追踪防护", exact: true })
      .getByText(/隐私保护：已默认拦截 2 项远程图片资源及 1 个疑似追踪像素/).waitFor();
    const frame = page.frameLocator('iframe[title="安全邮件正文"]');
    await frame.getByText("HTML 富文本", { exact: true }).waitFor();
    assert.equal(await frame.locator('img[alt="NormalBanner"]').getAttribute("data-ee-remote-src"), "https://cdn.example.invalid/normal-banner.png");
    assert.equal(await frame.locator('img[alt="NormalBanner"]').getAttribute("src"), null);
    assert.equal(await frame.locator('img[src^="http"]').count(), 0);

    const downloadBtn = detail.getByRole("button", { name: "下载 part-0.bin", exact: true });
    await downloadBtn.scrollIntoViewIfNeeded();
    await page.route("**/attachments/0", (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "attachment_source_changed" } }),
      }),
    );
    await downloadBtn.click();
    await detail.getByRole("alert").filter({ hasText: /附件源已变化/ }).waitFor();
    await page.unroute("**/attachments/0");

    await page.route("**/attachments/0", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/octet-stream",
        headers: { "content-length": "3" },
        body: Buffer.from("bad"),
      }),
    );
    await downloadBtn.click();
    await detail.getByRole("alert").filter({ hasText: /附件实际字节数与缓存元数据不一致/ }).waitFor();
    await page.unroute("**/attachments/0");

    assert.deepEqual(errors, []);
    assert.deepEqual(cspErrors, []);
    assert.deepEqual(external, []);
  } catch (error) {
    if (page) { console.error(await page.locator("body").ariaSnapshot()); await page.screenshot({ path: path.join(t.h.directory, "normal-access-remote-guard-failure.png"), fullPage: true }); }
    throw error;
  } finally { await browser?.close(); await t.close(); }
});
