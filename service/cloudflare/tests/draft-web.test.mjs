import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { createHarness, PASSWORD } from "./runtime-harness.mjs";
import { allocate } from "./provider-fixture.mjs";
import { sendFixture, sendCalls } from "./send-fixture.mjs";

async function login(page, h, username) {
  page.setDefaultTimeout(10000); await page.goto(h.baseUrl.href);
  await page.getByLabel("用户名", { exact: true }).fill(username); await page.getByLabel("密码", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "写信与发送记录", exact: true }).click();
}
const field = (p, name) => p.getByLabel(name, { exact: true });
const button = (p, name) => p.getByRole("button", { name, exact: true });

test("Chrome: cloud draft recovery, two-device conflicts, lost save/send responses and submitted-draft guards", { timeout: 120000 }, async () => {
  const f = await sendFixture(); let h, browser, a, b;
  try {
    h = await createHarness(f.bindings, true); const alice = await h.register("cloud-draft-web"), bob = await h.register("cloud-draft-other");
    const created = await allocate(h, alice.cookie); assert.equal(created.status, 201, created.text); const box = created.body.mailbox;
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    a = await browser.newPage(); b = await browser.newPage(); const errors = [], external = [];
    for (const page of [a, b]) {
      page.on("pageerror", error => errors.push(error.message));
      page.on("request", request => { if (!request.url().startsWith(h.baseUrl.origin)) external.push(request.url()); });
    }
    await login(a, h, alice.username);
    await field(a, "发件邮箱").locator(`option[value="${box.id}"]`).waitFor({ state: "attached" });
    await field(a, "发件邮箱").selectOption(box.id); await field(a, "邮件主题").fill("跨设备草稿");
    await field(a, "纯文本正文").fill("第一台设备的未完成正文");
    let lost = false; const writes = [];
    await a.route("**/api/v1/drafts/*", async route => {
      if (route.request().method() !== "PUT") return route.continue();
      writes.push(route.request().url());
      if (!lost) { lost = true; await route.fetch(); await route.abort("connectionfailed"); } else await route.continue();
    });
    await button(a, "保存云端草稿").click(); await a.getByRole("alert").filter({ hasText: "连接失败" }).waitFor();
    await button(a, "保存云端草稿").click(); await a.getByRole("status").filter({ hasText: "已保存到云端 · 版本 1" }).waitFor();
    assert.equal(new Set(writes).size, 1); assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM drafts").first("n"), 1);
    await a.unroute("**/api/v1/drafts/*");
    await login(b, h, alice.username); await b.getByRole("region", { name: "云端草稿", exact: true }).getByRole("button", { name: "跨设备草稿", exact: true }).click();
    await field(b, "纯文本正文").filter({ hasText: "第一台设备的未完成正文" }).waitFor();
    assert.equal(await field(b, "收件地址").inputValue(), ""); assert.equal(sendCalls(f).length, 0);
    await field(a, "纯文本正文").fill("A 的新版本"); await button(a, "保存云端草稿").click();
    await a.getByRole("status").filter({ hasText: "版本 2" }).waitFor();
    await field(b, "纯文本正文").fill("B 不能覆盖的新编辑"); await button(b, "保存云端草稿").click();
    await b.getByRole("alert").filter({ hasText: "云端草稿已变化" }).waitFor(); assert.equal(await field(b, "纯文本正文").inputValue(), "B 不能覆盖的新编辑");
    b.once("dialog", dialog => dialog.dismiss()); await button(b, "核对云端版本").click();
    assert.equal(await field(b, "纯文本正文").inputValue(), "B 不能覆盖的新编辑");
    b.once("dialog", dialog => dialog.accept()); await button(b, "核对云端版本").click();
    await b.getByRole("status").filter({ hasText: "已保存到云端 · 版本 2" }).waitFor(); assert.equal(await field(b, "纯文本正文").inputValue(), "A 的新版本");
    await field(b, "收件地址").fill("recipient@example.test"); await button(b, "保存云端草稿").click();
    await b.getByRole("status").filter({ hasText: "已保存到云端 · 版本 3" }).waitFor();
    await b.route("**/api/v1/mailboxes/*/outgoing", async route => { await route.fetch(); await route.abort("connectionfailed"); });
    await field(b, "我已核对收件地址和内容，确认提交一次发送").check(); await button(b, "确认发送").click();
    await button(b, "检查本次发送结果").waitFor(); assert.equal(sendCalls(f).length, 1);
    await b.reload(); await button(b, "写信与发送记录").click();
    await b.getByRole("region", { name: "云端草稿", exact: true }).getByRole("button", { name: "跨设备草稿", exact: true }).click();
    await b.getByRole("status").filter({ hasText: "此草稿已提交发送" }).waitFor();
    assert.equal(await field(b, "纯文本正文").isDisabled(), true); assert.equal(await button(b, "确认发送").isDisabled(), true);
    await button(b, "新建另一封邮件").click(); assert.equal(await field(b, "纯文本正文").inputValue(), "");
    await field(b, "发件邮箱").selectOption(box.id); await field(b, "收件地址").fill("recipient@example.test");
    await field(b, "邮件主题").fill("结果未知的草稿"); await field(b, "纯文本正文").fill("保留原发送键");
    await button(b, "保存云端草稿").click(); await b.getByRole("status").filter({ hasText: "已保存到云端 · 版本 1" }).waitFor();
    await b.unroute("**/api/v1/mailboxes/*/outgoing"); f.modes.set("/cf/admin/send_mail_by_binding", "disconnect");
    await field(b, "我已核对收件地址和内容，确认提交一次发送").check(); await button(b, "确认发送").click();
    await button(b, "检查本次发送结果").waitFor(); const sendKey = await b.getByTestId("send-attempt-key").textContent();
    const replay = b.waitForResponse(response => response.url().endsWith(`/mailboxes/${box.id}/outgoing`));
    await button(b, "检查本次发送结果").click(); assert.equal((await replay).status(), 202);
    assert.equal(await b.getByTestId("send-attempt-key").textContent(), sendKey); assert.equal(sendCalls(f).length, 2);
    const other = await browser.newPage(); await login(other, h, bob.username);
    await other.getByText("暂无云端草稿", { exact: true }).waitFor();
    await button(a, "刷新草稿").click();
    const row = a.getByRole("region", { name: "云端草稿", exact: true }).getByRole("listitem").filter({ hasText: "跨设备草稿" });
    await row.getByText(/版本 4/).waitFor();
    a.once("dialog", dialog => dialog.accept()); await row.getByRole("button", { name: "删除草稿", exact: true }).click();
    await row.waitFor({ state: "detached" }); assert.equal(await field(a, "纯文本正文").inputValue(), "");
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM outgoing_messages").first("n"), 2);
    assert.equal(sendCalls(f).length, 2);
    await a.getByRole("combobox", { name: "权限", exact: true }).selectOption("drafts");
    await field(a, "名称").fill("cloud-drafts-key"); await button(a, "创建 Key").click();
    const token = await a.getByTestId("new-key").textContent();
    assert.equal((await h.request("/api/v1/drafts", { token, origin: null })).status, 200);
    assert.deepEqual(JSON.parse(await h.db.prepare("SELECT scopes FROM api_keys WHERE name='cloud-drafts-key'").first("scopes")), ["mailboxes:read", "drafts:read", "drafts:write"]);
    await b.setViewportSize({ width: 390, height: 844 }); assert.equal(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await b.screenshot({ path: path.join(h.directory, "cloud-drafts-mobile.png"), fullPage: true });
    for (const page of [a, b]) assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log(`Cloud draft browser evidence: ${h.directory}`);
  } catch (error) {
    if (b) { console.error(await b.locator("body").ariaSnapshot()); await b.screenshot({ path: path.join(h.directory, "cloud-drafts-failure.png"), fullPage: true }); }
    throw error;
  } finally { await browser?.close(); await h?.close(); await f.close(); }
});
