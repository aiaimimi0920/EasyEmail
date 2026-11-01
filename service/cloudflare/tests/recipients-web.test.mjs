import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { createHarness, PASSWORD } from "./runtime-harness.mjs";
import { allocate } from "./provider-fixture.mjs";
import { sendFixture, sendCalls } from "./send-fixture.mjs";
import { contactBody, saveContact } from "./contacts-fixture.mjs";
const field = (p, name) => p.getByLabel(name, { exact: true });
const button = (p, name) => p.getByRole("button", { name, exact: true });
async function login(p, h, name) {
  p.setDefaultTimeout(10000); await p.goto(h.baseUrl.href);
  await field(p, "用户名").fill(name); await field(p, "密码").fill(PASSWORD); await button(p, "登录").click();
  await button(p, "写信与发送记录").click();
}

test("Chrome: multiple recipient editor, targeted contact selection, cross-device drafts, immutable lost-response recovery and private history", { timeout: 120000 }, async () => {
  const f = await sendFixture(); let h, browser, a, b;
  try {
    h = await createHarness(f.bindings, true); const alice = await h.register("recipient-web"), bob = await h.register("recipient-other");
    const box = (await allocate(h, alice.cookie)).body.mailbox;
    const contact = await saveContact(h, alice, contactBody("private@example.test", "私有联系人")); assert.equal(contact.status, 201, contact.text);
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    a = await browser.newPage(); b = await browser.newPage(); const errors = [], external = [];
    for (const p of [a, b]) { p.on("pageerror", error => errors.push(error.message)); p.on("request", request => { if (!request.url().startsWith(h.baseUrl.origin)) external.push(request.url()); }); }
    await login(a, h, alice.username); await field(a, "发件邮箱").locator(`option[value="${box.id}"]`).waitFor({ state: "attached" });
    await field(a, "发件邮箱").selectOption(box.id); await field(a, "收件地址").fill("one@example.test");
    await field(a, "抄送地址").fill("copy@example.test"); await field(a, "邮件主题").fill("完整收件人草稿"); await field(a, "纯文本正文").fill("CC/BCC 云端编辑");
    await button(a, "从联系人选择").click(); await a.getByRole("combobox", { name: "收件联系人", exact: true }).selectOption(contact.body.operation.contactId);
    await field(a, "联系人目标").selectOption("bcc"); await field(a, "我已核对收件地址和内容，确认提交一次发送").check();
    await button(a, "追加此地址").click();
    assert.equal(await field(a, "密送地址").inputValue(), "private@example.test"); assert.equal(await field(a, "收件地址").inputValue(), "one@example.test");
    assert.equal(await field(a, "我已核对收件地址和内容，确认提交一次发送").isChecked(), false); assert.equal(sendCalls(f).length, 0);
    await field(a, "收件地址").fill("one@example.test, two@example.test"); await button(a, "保存云端草稿").click();
    await a.getByRole("status").filter({ hasText: "已保存到云端 · 版本 1" }).waitFor();
    await login(b, h, alice.username); await b.getByRole("region", { name: "云端草稿", exact: true }).getByRole("button", { name: "完整收件人草稿", exact: true }).click();
    await b.getByRole("status").filter({ hasText: "已保存到云端 · 版本 1" }).waitFor();
    assert.deepEqual((await field(b, "收件地址").inputValue()).split(",").map(value => value.trim()), ["one@example.test", "two@example.test"]);
    assert.equal(await field(b, "密送地址").inputValue(), "private@example.test");
    await field(b, "收件地址").fill("one@example.test"); await button(b, "保存云端草稿").click();
    await b.getByRole("status").filter({ hasText: "已保存到云端 · 版本 2" }).waitFor();
    const writes = []; let lost = false;
    await b.route("**/api/v1/mailboxes/*/outgoing", async route => {
      writes.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
      if (!lost) { lost = true; await route.fetch(); await route.abort("connectionfailed"); } else await route.continue();
    });
    await field(b, "我已核对收件地址和内容，确认提交一次发送").check(); await button(b, "确认发送").click(); await button(b, "检查本次发送结果").waitFor();
    for (const label of ["收件地址", "抄送地址", "密送地址"]) assert.equal(await field(b, label).isDisabled(), true);
    await button(b, "联系人").click(); await button(b, "写信与发送记录").click(); await button(b, "检查本次发送结果").click();
    await b.getByRole("region", { name: "写信", exact: true }).getByRole("status").filter({ hasText: "渠道已接受" }).waitFor();
    assert.deepEqual(writes[0], writes[1]); assert.equal(sendCalls(f).length, 1); assert.deepEqual(sendCalls(f)[0].body.bcc, ["private@example.test"]);
    await b.getByRole("region", { name: "发送记录", exact: true }).getByRole("button", { name: "完整收件人草稿", exact: true }).click();
    await b.getByRole("article", { name: "发送详情", exact: true }).getByText("密送：private@example.test", { exact: true }).waitFor();
    const other = await browser.newPage(); await login(other, h, bob.username); await other.getByText("暂无发送记录", { exact: true }).waitFor();
    assert.equal((await other.locator("body").textContent()).includes("private@example.test"), false);
    await b.setViewportSize({ width: 390, height: 844 }); assert.equal(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await b.screenshot({ path: path.join(h.directory, "recipients-mobile.png"), fullPage: true });
    for (const p of [a, b, other]) assert.equal(await p.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
  } catch (error) { if (b) console.error(await b.locator("body").ariaSnapshot()); throw error; }
  finally { await browser?.close(); await h?.close(); await f.close(); }
});

test("Chrome: unsupported worker capability preserves CC/BCC drafts and disables sending without a dispatch", { timeout: 90000 }, async () => {
  const f = await sendFixture("worker"); let h, browser;
  try {
    h = await createHarness(f.bindings, true); const user = await h.register("recipient-worker-web"), box = (await allocate(h, user.cookie)).body.mailbox;
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    const p = await browser.newPage(); await login(p, h, user.username); await field(p, "发件邮箱").locator(`option[value="${box.id}"]`).waitFor({ state: "attached" });
    await field(p, "发件邮箱").selectOption(box.id); await field(p, "收件地址").fill("one@example.test"); await field(p, "密送地址").fill("private@example.test");
    await field(p, "邮件主题").fill("不支持的通道"); await field(p, "纯文本正文").fill("不得丢弃 BCC"); await field(p, "我已核对收件地址和内容，确认提交一次发送").check();
    assert.equal(await button(p, "确认发送").isDisabled(), true); await button(p, "保存云端草稿").click();
    await p.getByRole("status").filter({ hasText: "已保存到云端 · 版本 1" }).waitFor(); assert.equal(await field(p, "密送地址").inputValue(), "private@example.test");
    assert.equal(sendCalls(f).length, 0); assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM outgoing_messages").first("n"), 0);
  } finally { await browser?.close(); await h?.close(); await f.close(); }
});
