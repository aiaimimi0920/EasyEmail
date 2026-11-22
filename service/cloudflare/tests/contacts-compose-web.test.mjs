import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { createHarness, PASSWORD } from "./runtime-harness.mjs";
import { allocate, cfMail } from "./provider-fixture.mjs";
import { sendFixture, sendCalls } from "./send-fixture.mjs";
import { contactBody, saveContact, expect } from "./contacts-fixture.mjs";

const field = (p, name) => p.getByLabel(name, { exact: true });
const recipientPicker = p => p.getByRole("combobox", { name: "收件联系人", exact: true });
const button = (p, name) => p.getByRole("button", { name, exact: true });
const confirmed = p => field(p, "我已核对收件地址和内容，确认提交一次发送");

test("Chrome: contact selection preserves reply/draft content, clears consent and cannot bypass send policy or mutate locked attempts", { timeout: 120000 }, async () => {
  const f = await sendFixture("binding", ["allowed@example.test"]); let h, browser, page, releaseSave;
  try {
    h = await createHarness(f.bindings, true); const alice = await h.register("contact-compose-web");
    const allowed = expect(await saveContact(h, alice, contactBody("allowed@example.test", "允许的收件人")), 201).operation.contactId;
    const denied = expect(await saveContact(h, alice, contactBody("denied@example.test", "未授权收件人")), 201).operation.contactId;
    const box = expect(await allocate(h, alice.cookie), 201).mailbox;
    f.messages.set(box.address, [{ ...cfMail(box.address, 1), sender: "Reply <reply@example.test>", message_id: "<contact-reply@example.test>" }]);
    expect(await h.request(`/api/v1/mailboxes/${box.id}/sync`, { cookie: alice.cookie, method: "POST", body: {} }));
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    page = await browser.newPage(); page.setDefaultTimeout(10000); const errors = [], external = [];
    page.on("pageerror", error => errors.push(error.message)); page.on("request", request => { if (!request.url().startsWith(h.baseUrl.origin)) external.push(request.url()); });
    await page.goto(h.baseUrl.href); await field(page, "用户名").fill(alice.username); await field(page, "密码").fill(PASSWORD); await button(page, "登录").click();
    await button(page, "聚合收件箱").click(); await button(page, "Verify your account").click(); await button(page, "回复").click();
    await page.getByRole("heading", { name: "回复邮件", exact: true }).waitFor(); await field(page, "发件邮箱").locator(`option[value="${box.id}"]`).waitFor({ state: "attached" });
    await field(page, "纯文本正文").fill("联系人选择不改变回复正文"); await confirmed(page).check();
    let failList = true;
    await page.route("**/api/v1/contacts?**", route => failList
      ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "contact_storage_failed" } }) }) : route.continue());
    await button(page, "从联系人选择").click(); await page.getByRole("alert").filter({ hasText: "联系人操作未确认" }).waitFor();
    assert.equal(await field(page, "收件地址").isDisabled(), false); await field(page, "收件地址").fill("manual@example.test");
    failList = false; await button(page, "从联系人选择").click(); await button(page, "从联系人选择").click();
    await recipientPicker(page).locator(`option[value="${allowed}"]`).waitFor({ state: "attached" }); await recipientPicker(page).selectOption(allowed);
    await confirmed(page).check(); await button(page, "使用此收件地址").click();
    assert.equal(await field(page, "收件地址").inputValue(), "allowed@example.test"); assert.equal(await confirmed(page).isChecked(), false);
    assert.equal(await field(page, "邮件主题").inputValue(), "Re: Verify your account"); assert.equal(await field(page, "纯文本正文").inputValue(), "联系人选择不改变回复正文");
    assert.equal(sendCalls(f).length, 0);
    let enterSave; const entered = new Promise(resolve => { enterSave = resolve; }), held = new Promise(resolve => { releaseSave = resolve; });
    await page.route("**/api/v1/drafts/*", async route => { if (route.request().method() !== "PUT") return route.continue(); enterSave(); await held; await route.continue(); });
    await button(page, "保存云端草稿").click(); await entered;
    assert.equal(await button(page, "使用此收件地址").isDisabled(), true); assert.equal(await recipientPicker(page).isDisabled(), true);
    releaseSave(); await page.getByRole("status").filter({ hasText: "已保存到云端 · 版本 1" }).waitFor(); await page.unroute("**/api/v1/drafts/*");
    await recipientPicker(page).selectOption(denied); await button(page, "使用此收件地址").click(); await button(page, "保存云端草稿").click();
    await page.getByRole("status").filter({ hasText: "已保存到云端 · 版本 2" }).waitFor(); await confirmed(page).check(); await button(page, "确认发送").click();
    await page.getByRole("alert").filter({ hasText: "收件地址不在管理员允许范围内" }).waitFor(); assert.equal(sendCalls(f).length, 0);
    await recipientPicker(page).selectOption(allowed); await button(page, "使用此收件地址").click(); await button(page, "保存云端草稿").click();
    await page.getByRole("status").filter({ hasText: "已保存到云端 · 版本 3" }).waitFor();
    const requests = []; let lost = false;
    await page.route("**/api/v1/mailboxes/*/outgoing", async route => {
      requests.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
      if (!lost) { lost = true; await route.fetch(); await route.abort("connectionfailed"); } else await route.continue();
    });
    await confirmed(page).check(); await button(page, "确认发送").click(); await button(page, "检查本次发送结果").waitFor();
    const key = await page.getByTestId("send-attempt-key").textContent(); assert.equal(sendCalls(f).length, 1);
    for (const control of [button(page, "从联系人选择"), button(page, "使用此收件地址"), recipientPicker(page), field(page, "收件地址")]) assert.equal(await control.isDisabled(), true);
    await button(page, "联系人").click(); await button(page, "写信与发送记录").click(); assert.equal(await page.getByTestId("send-attempt-key").textContent(), key);
    await button(page, "检查本次发送结果").click(); await page.getByRole("region", { name: "写信", exact: true }).getByRole("status").filter({ hasText: "渠道已接受" }).waitFor();
    assert.deepEqual(requests[0], requests[1]); assert.equal(sendCalls(f).length, 1); assert.deepEqual(sendCalls(f)[0].body.to, ["allowed@example.test"]);
    assert.deepEqual(sendCalls(f)[0].body.headers, { "In-Reply-To": "<contact-reply@example.test>", References: "<contact-reply@example.test>" });
    assert.equal(await button(page, "使用此收件地址").isDisabled(), true);
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(h.directory, "contact-picker-mobile.png"), fullPage: true });
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0); assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log(`Contact picker browser evidence: ${h.directory}`);
  } catch (error) {
    if (page) { console.error(await page.locator("body").ariaSnapshot()); await page.screenshot({ path: path.join(h.directory, "contact-picker-failure.png"), fullPage: true }); }
    throw error;
  } finally { releaseSave?.(); await browser?.close(); await h?.close(); await f.close(); }
});
