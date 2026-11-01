import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { PASSWORD } from "./runtime-harness.mjs";
import { assetBytes, outboxFixture } from "./outbox-fixture.mjs";
import { sendCalls } from "./send-fixture.mjs";
import path from "node:path";
const field = (p, name) => p.getByLabel(name, { exact: true });
const button = (p, name) => p.getByRole("button", { name, exact: true });
async function login(p, t) {
  p.setDefaultTimeout(10000); await p.goto(t.h.baseUrl.href);
  await field(p, "用户名").fill(t.alice.username); await field(p, "密码").fill(PASSWORD); await button(p, "登录").click();
  await button(p, "写信与发送记录").click();
}
test("Chrome: actual binary upload, original-resource recovery, cross-device draft and immutable one-dispatch send", { timeout: 120000 }, async () => {
  const t = await outboxFixture({ browser: true }); let browser, p;
  try {
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    p = await browser.newPage(); const errors = [], external = [], writes = [];
    p.on("pageerror", error => errors.push(error.message)); p.on("request", r => { if (!r.url().startsWith(t.h.baseUrl.origin)) external.push(r.url()); });
    await login(p, t); await field(p, "发件邮箱").selectOption(t.box.id);
    await field(p, "收件地址").fill("recipient@example.test"); await field(p, "邮件主题").fill("跨设备二进制附件"); await field(p, "纯文本正文").fill("合成内容，非公网投递");
    let lostUpload = false;
    await p.route("**/api/v1/outbox-attachments/*/content", async route => {
      if (route.request().method() === "PUT" && !lostUpload) { lostUpload = true; await route.fetch(); await route.abort("connectionfailed"); }
      else await route.continue();
    });
    await field(p, "添加发送附件").setInputFiles({ name: "binary-proof.bin", mimeType: "application/octet-stream", buffer: Buffer.from(assetBytes) });
    await button(p, "核对原上传").waitFor();
    assert.equal(await button(p, "保存云端草稿").isDisabled(), true); assert.equal(await button(p, "确认发送").isDisabled(), true);
    await button(p, "核对原上传").click(); await p.getByText("binary-proof.bin", { exact: true }).waitFor();
    await p.setViewportSize({ width: 390, height: 844 });
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await p.screenshot({ path: path.join(t.h.directory, "outbox-mobile.png"), fullPage: true });
    await button(p, "保存云端草稿").click(); await p.getByRole("status").filter({ hasText: "已保存到云端 · 版本 1" }).waitFor();
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM outbox_assets").first("n"), 1);
    const other = await browser.newPage(); await login(other, t);
    await other.getByRole("region", { name: "云端草稿", exact: true }).getByRole("button", { name: "跨设备二进制附件", exact: true }).click();
    await other.getByText("binary-proof.bin", { exact: true }).waitFor();
    let lostSend = false;
    await other.route("**/api/v1/mailboxes/*/outgoing", async route => {
      writes.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
      if (!lostSend) { lostSend = true; await route.fetch(); await route.abort("connectionfailed"); } else await route.continue();
    });
    await field(other, "我已核对收件地址和内容，确认提交一次发送").check(); await button(other, "确认发送").click();
    await button(other, "检查本次发送结果").waitFor(); assert.equal(await field(other, "添加发送附件").isDisabled(), true);
    await button(other, "检查本次发送结果").click();
    await other.getByRole("region", { name: "写信", exact: true }).getByRole("status").filter({ hasText: "渠道已接受" }).waitFor();
    assert.deepEqual(writes[0], writes[1]); assert.equal(sendCalls(t.f).length, 1);
    assert.deepEqual(new Uint8Array(Buffer.from(sendCalls(t.f)[0].body.attachments[0].content, "base64")), assetBytes);
    await other.getByRole("region", { name: "发送记录", exact: true }).getByRole("button", { name: "跨设备二进制附件", exact: true }).click();
    await other.getByRole("article", { name: "发送详情", exact: true }).getByText(/binary-proof.bin/).waitFor();
    for (const page of [p, other]) assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
  } catch (error) { if (p) console.error(await p.locator("body").ariaSnapshot()); throw error; }
  finally { await browser?.close(); await t.close(); }
});

test("Chrome: unsupported channels retain references and expiry blocks sending until the user removes the reference", { timeout: 90000 }, async () => {
  const t = await outboxFixture({ browser: true, transport: "worker" }); let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    const p = await browser.newPage(); await login(p, t); await field(p, "发件邮箱").selectOption(t.box.id);
    await field(p, "收件地址").fill("recipient@example.test"); await field(p, "邮件主题").fill("保留附件"); await field(p, "纯文本正文").fill("不得静默丢弃附件");
    await field(p, "添加发送附件").setInputFiles({ name: "retained.bin", mimeType: "application/octet-stream", buffer: Buffer.from(assetBytes) });
    await p.getByText("retained.bin", { exact: true }).waitFor();
    await p.getByRole("status").filter({ hasText: "此发送通道不支持附件" }).waitFor();
    await field(p, "我已核对收件地址和内容，确认提交一次发送").check(); assert.equal(await button(p, "确认发送").isDisabled(), true);
    await button(p, "保存云端草稿").click(); await p.getByRole("status").filter({ hasText: "已保存到云端 · 版本 1" }).waitFor();
    await t.h.db.exec("UPDATE outbox_assets SET expires_at=unixepoch()-1"); await button(p, "核对附件状态").click();
    await p.getByRole("status").filter({ hasText: "附件不可用，请移除引用或重新上传" }).waitFor();
    assert.equal(await button(p, "确认发送").isDisabled(), true); assert.equal(sendCalls(t.f).length, 0);
    await button(p, "移除引用").click(); assert.equal(await field(p, "纯文本正文").inputValue(), "不得静默丢弃附件");
    assert.equal(await field(p, "我已核对收件地址和内容，确认提交一次发送").isChecked(), false);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM outbox_assets").first("n"), 1, "Removing a draft reference does not erase another draft's resource");
    assert.equal(sendCalls(t.f).length, 0);
  } finally { await browser?.close(); await t.close(); }
});
