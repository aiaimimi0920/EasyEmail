import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { createHarness, INVITE, PASSWORD } from "./runtime-harness.mjs";
import { cfMail } from "./provider-fixture.mjs";
import { sendFixture, sendCalls } from "./send-fixture.mjs";

test("Chrome: explicit reply, durable send history and lost response -> 429 -> same-key replay across navigation", { timeout: 90000 }, async () => {
  const f = await sendFixture(); let h, browser, page;
  try {
    h = await createHarness(f.bindings, true);
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH
      ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
    page.setDefaultTimeout(10000);
    const errors = [], external = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => { if (!request.url().startsWith(h.baseUrl.origin)) external.push(request.url()); });
    await page.goto(h.baseUrl.href);
    await page.getByRole("button", { name: "使用邀请口令注册", exact: true }).click();
    await page.getByLabel("用户名", { exact: true }).fill("send-web-alice");
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD);
    await page.getByLabel("邀请口令", { exact: true }).fill(INVITE);
    await page.getByRole("button", { name: "注册", exact: true }).click();
    await page.getByRole("combobox", { name: "域名", exact: true }).selectOption("cf.example.test");
    await page.getByRole("button", { name: "分配随机邮箱", exact: true }).click();
    await page.getByRole("heading", { name: "收件箱", exact: true }).waitFor();
    const box = await h.db.prepare("SELECT * FROM mailboxes LIMIT 1").first();
    f.messages.set(box.address, [{ ...cfMail(box.address, 1), sender: '"支持团队" <support@example.test>', message_id: "<reply-web@example.test>" }]);
    await page.getByRole("button", { name: "刷新收信", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "本页读取 1 封" }).waitFor();
    await page.getByRole("button", { name: "聚合收件箱", exact: true }).click();
    await page.getByRole("button", { name: "Verify your account", exact: true }).click();
    await page.getByRole("button", { name: "回复", exact: true }).click();
    await page.getByRole("heading", { name: "回复邮件", exact: true }).waitFor();
    await page.getByLabel("发件邮箱", { exact: true }).locator(`option[value="${box.id}"]`).waitFor({ state: "attached" });
    assert.equal(await page.getByLabel("收件地址", { exact: true }).inputValue(), "support@example.test");
    assert.equal(await page.getByLabel("邮件主题", { exact: true }).inputValue(), "Re: Verify your account");
    assert.equal(await page.getByLabel("发件邮箱", { exact: true }).inputValue(), box.id);
    assert.equal(sendCalls(f).length, 0, "Opening and preparing a reply is not sending");
    await page.getByLabel("纯文本正文", { exact: true }).fill("明确确认的回复内容");
    assert.equal(await page.getByRole("button", { name: "确认发送", exact: true }).isDisabled(), true);
    await page.getByRole("checkbox", { name: "我已核对收件地址和内容，确认提交一次发送", exact: true }).check();
    await page.getByRole("button", { name: "确认发送", exact: true }).click();
    await page.getByRole("region", { name: "写信", exact: true }).getByRole("status").filter({ hasText: "渠道已接受（未确认送达）" }).waitFor();
    assert.equal(sendCalls(f).length, 1);
    assert.deepEqual(sendCalls(f)[0].body.headers, { "In-Reply-To": "<reply-web@example.test>", References: "<reply-web@example.test>" });
    await page.getByRole("region", { name: "发送记录", exact: true }).getByRole("button", { name: "Re: Verify your account", exact: true }).click();
    await page.getByRole("article", { name: "发送详情", exact: true }).getByText("明确确认的回复内容", { exact: true }).waitFor();
    await page.getByRole("button", { name: "新建另一封邮件", exact: true }).click();
    await page.getByLabel("发件邮箱", { exact: true }).selectOption(box.id);
    await page.getByLabel("收件地址", { exact: true }).fill("another@example.test");
    await page.getByLabel("邮件主题", { exact: true }).fill("Lost response recovery");
    await page.getByLabel("纯文本正文", { exact: true }).fill("响应丢失后不可重复发送");
    await page.getByRole("checkbox", { name: "我已核对收件地址和内容，确认提交一次发送", exact: true }).check();
    const keys = []; let tries = 0;
    await page.route("**/api/v1/mailboxes/*/outgoing", async (route) => {
      keys.push(route.request().headers()["idempotency-key"]); tries++;
      if (tries === 1) { await route.fetch(); await route.abort("connectionfailed"); }
      else if (tries === 2) await route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: { code: "rate_limited" } }) });
      else await route.continue();
    });
    await page.getByRole("button", { name: "确认发送", exact: true }).click();
    await page.getByRole("button", { name: "检查本次发送结果", exact: true }).waitFor();
    const attemptKey = await page.getByTestId("send-attempt-key").textContent();
    await page.getByRole("button", { name: "邮箱管理", exact: true }).click();
    await page.getByRole("button", { name: "写信与发送记录", exact: true }).click();
    assert.equal(await page.getByTestId("send-attempt-key").textContent(), attemptKey);
    assert.equal(await page.getByLabel("邮件主题", { exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "检查本次发送结果", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "操作过于频繁" }).waitFor();
    assert.equal(await page.getByTestId("send-attempt-key").textContent(), attemptKey);
    await page.getByRole("button", { name: "检查本次发送结果", exact: true }).click();
    await page.getByRole("region", { name: "写信", exact: true }).getByRole("status").filter({ hasText: "渠道已接受" }).waitFor();
    assert.deepEqual(keys, [attemptKey, attemptKey, attemptKey]); assert.equal(sendCalls(f).length, 2);
    await page.unroute("**/api/v1/mailboxes/*/outgoing");
    await page.getByRole("combobox", { name: "权限", exact: true }).selectOption("send");
    await page.getByLabel("名称", { exact: true }).fill("send automation");
    await page.getByRole("button", { name: "创建 Key", exact: true }).click();
    const token = await page.getByTestId("new-key").textContent();
    const record = await h.db.prepare("SELECT scopes FROM api_keys WHERE name = 'send automation'").first();
    assert.deepEqual(JSON.parse(record.scopes), ["mailboxes:read", "messages:read", "messages:send"]);
    assert.equal((await h.request("/api/v1/outgoing", { token })).body.items.length, 2);
    await page.reload();
    await page.getByRole("button", { name: "写信与发送记录", exact: true }).click();
    await page.getByRole("region", { name: "发送记录", exact: true }).getByRole("button", { name: "Lost response recovery", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(h.directory, "send-mobile.png"), fullPage: true });
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log(`M3b Chrome evidence: ${h.directory}`);
  } catch (error) {
    if (page) { console.error(await page.locator("body").ariaSnapshot()); await page.screenshot({ path: path.join(h.directory, "send-failure.png"), fullPage: true }); }
    throw error;
  } finally { await browser?.close(); await h?.close(); await f.close(); }
});
