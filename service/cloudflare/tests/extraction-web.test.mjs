import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { createHarness, INVITE, PASSWORD } from "./runtime-harness.mjs";
import { cfMail, providerFixture } from "./provider-fixture.mjs";

test("Chrome: fresh OTP/link waiting, fixed filters, explicit stop, navigation cancellation and no external visits", { timeout: 90000 }, async () => {
  const f = await providerFixture(); let h, browser, page;
  const gates = [];
  try {
    h = await createHarness(f.bindings, true);
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH
      ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); page.setDefaultTimeout(10000);
    const errors = [], external = [], checks = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (!request.url().startsWith(h.baseUrl.origin)) external.push(request.url());
      if (request.url().endsWith("/extractions/check")) checks.push(request.postDataJSON());
    });
    await page.goto(h.baseUrl.href);
    await page.getByRole("button", { name: "使用邀请口令注册", exact: true }).click();
    await page.getByLabel("用户名", { exact: true }).fill("extraction-web-alice");
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD);
    await page.getByLabel("邀请口令", { exact: true }).fill(INVITE);
    await page.getByRole("button", { name: "注册", exact: true }).click();
    await page.getByRole("combobox", { name: "域名", exact: true }).selectOption("cf.example.test");
    await page.getByRole("button", { name: "分配随机邮箱", exact: true }).click();
    await page.getByRole("heading", { name: "收件箱", exact: true }).waitFor();
    const box = await h.db.prepare("SELECT * FROM mailboxes LIMIT 1").first();
    f.messages.set(box.address, [cfMail(box.address, 1, "Your verification code is 111222.", new Date(Date.now() - 600000).toISOString())]);
    await page.getByLabel("发件人包含", { exact: true }).fill("noreply");
    await page.getByLabel("主题包含", { exact: true }).fill("verify");
    await page.getByRole("combobox", { name: "提取目标", exact: true }).selectOption("otp");
    const first = page.waitForResponse((r) => r.url().endsWith("/extractions/check"));
    const startedAt = Math.floor(Date.now() / 1000);
    await page.getByRole("button", { name: "等待新结果（60 秒）", exact: true }).click();
    assert.equal((await first).status(), 200);
    await page.getByRole("status").filter({ hasText: "第 1/12 次" }).waitFor();
    assert.equal(await page.getByTestId("otp-code").count(), 0);
    assert.ok(checks[0].since >= startedAt);
    assert.equal(checks[0].sender, "noreply"); assert.equal(checks[0].subject, "verify"); assert.equal(checks[0].recipient, box.address);
    assert.equal(await page.getByLabel("发件人包含", { exact: true }).isDisabled(), true);
    const mail = { ...cfMail(box.address, 2, "Your verification code is 987456.", new Date().toISOString()),
      html: '<a href="https://auth.example.test/verify?token=synthetic-wait">Verify</a><img src="https://evil.invalid/track">' };
    f.messages.get(box.address).unshift(mail);
    await page.getByTestId("otp-code").waitFor();
    assert.equal(await page.getByTestId("otp-code").textContent(), "987456");
    assert.equal(checks.length, 2); assert.equal(checks[1].since, checks[0].since);
    assert.equal(await page.locator('a[href*="auth.example.test"]').count(), 0);
    await page.getByRole("button", { name: mail.subject, exact: true }).first().waitFor();
    const completed = checks.length;
    await page.waitForTimeout(5200); assert.equal(checks.length, completed, "success stops polling");

    // Explicitly abort an in-flight read; no late response may leak into a subsequent view.
    const gate = f.hold("/cf/api/parsed_mails"); gates.push(gate);
    await page.getByRole("button", { name: "等待新结果（60 秒）", exact: true }).click(); await gate.entered;
    await page.getByRole("button", { name: "停止等待", exact: true }).click();
    const cancelled = checks.length;
    gate.release(); await page.waitForTimeout(300);
    assert.equal(await page.getByTestId("otp-code").count(), 0);
    await page.getByRole("status").filter({ hasText: "已停止等待" }).waitFor();
    await page.waitForTimeout(5200); assert.equal(checks.length, cancelled);

    await page.getByRole("combobox", { name: "提取目标", exact: true }).selectOption("link");
    const navigateGate = f.hold("/cf/api/parsed_mails"); gates.push(navigateGate);
    await page.getByRole("button", { name: "等待新结果（60 秒）", exact: true }).click(); await navigateGate.entered;
    await page.getByRole("button", { name: "聚合收件箱", exact: true }).click();
    const navigated = checks.length; navigateGate.release(); await page.waitForTimeout(5300);
    assert.equal(checks.length, navigated);
    await page.getByRole("button", { name: "邮箱管理", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "停止等待", exact: true }).count(), 0);
    f.messages.set(box.address, [{ ...mail, id: 3, text: "Follow the link", created_at: new Date(Date.now() + 1000).toISOString() }]);
    await page.getByRole("button", { name: "等待新结果（60 秒）", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "已找到匹配结果" }).waitFor();
    assert.equal(await page.getByTestId("otp-code").count(), 0);
    assert.ok((await page.locator("body").innerText()).includes("synthetic-wait"));
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(h.directory, "extraction-wait-mobile.png"), fullPage: true });
    const pauseGate = f.hold("/cf/api/parsed_mails"); gates.push(pauseGate);
    await page.getByRole("button", { name: "等待新结果（60 秒）", exact: true }).click(); await pauseGate.entered;
    await page.getByRole("button", { name: "暂停平台同步", exact: true }).click();
    await page.getByRole("button", { name: "恢复平台同步", exact: true }).waitFor();
    const paused = checks.length; pauseGate.release(); await page.waitForTimeout(5300);
    assert.equal(checks.length, paused);
    assert.equal(await page.getByRole("button", { name: "停止等待", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "等待新结果（60 秒）", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "恢复平台同步", exact: true }).click();
    await page.getByRole("button", { name: "暂停平台同步", exact: true }).waitFor();
    const logoutGate = f.hold("/cf/api/parsed_mails"); gates.push(logoutGate);
    await page.getByRole("button", { name: "等待新结果（60 秒）", exact: true }).click(); await logoutGate.entered;
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await page.getByRole("button", { name: "登录", exact: true }).waitFor();
    const loggedOut = checks.length; logoutGate.release(); await page.waitForTimeout(5300);
    assert.equal(checks.length, loggedOut);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    assert.equal(f.calls.some((call) => call.method === "DELETE" || call.path.includes("send_mail")), false);
    console.log(`M3i Chrome evidence: ${h.directory}`);
  } catch (error) {
    if (page && h) { console.error(await page.locator("body").ariaSnapshot());
      await page.screenshot({ path: path.join(h.directory, "extraction-wait-failure.png"), fullPage: true }); }
    throw error;
  } finally { for (const gate of gates) gate.release(); await browser?.close(); await h?.close(); await f.close(); }
});
