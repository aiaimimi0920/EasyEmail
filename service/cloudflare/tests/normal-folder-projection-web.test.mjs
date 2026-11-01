import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { folderProjectionFixture, projectionMailboxes, expect } from "./normal-folder-projection-fixture.mjs";
import { ATTACHMENT, multipartMessage } from "./normal-mime-fixture.mjs";
import { PASSWORD } from "./runtime-harness.mjs";

const button = (p, name) => p.getByRole("button", { name, exact: true });
async function open(t) {
  const browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); page.setDefaultTimeout(15000);
  try {
    await page.goto(t.h.baseUrl.href); await page.getByLabel("用户名", { exact: true }).fill(t.alice.username);
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await button(page, "登录").click();
    await button(page.getByRole("navigation"), "聚合收件箱").click();
    return { browser, page, inbox: page.getByRole("region", { name: "聚合邮件", exact: true }) };
  } catch (error) { await browser.close(); throw error; }
}
test("Chrome: folder messages open from aggregate, conversation and subscription with exact downloads, explicit flags and epoch-local hide", { timeout: 180000 }, async () => {
  const mailboxes = projectionMailboxes(), raw = new TextEncoder().encode(new TextDecoder().decode(multipartMessage()).replace("Subject: attachments",
    "To: recipient@example.test\r\nSubject: Sent projection 1\r\nMessage-ID: <list1@example.test>\r\nReferences: <shared-root@example.test>\r\nList-ID: Updates <updates.example.test>"));
  mailboxes.get("Sent").messages.set(1, raw);
  const t = await folderProjectionFixture({ browser: true, mailboxes }); let browser, page;
  try {
    await t.receiveAll(); let inbox; ({ browser, page, inbox } = await open(t)); const writes = [], external = [], errors = [], legacyReads = [];
    page.on("pageerror", error => errors.push(error.message)); page.on("request", request => {
      if (!request.url().startsWith(t.h.baseUrl.origin)) external.push(request.url());
      if (request.method() !== "GET") writes.push(request.url());
      if (new RegExp(`/normal-accounts/${t.id}/messages/[^/?]+`).test(new URL(request.url()).pathname)) legacyReads.push(request.url());
    });
    await inbox.getByText("已加载 6 封", { exact: true }).waitFor();
    assert.equal(await inbox.getByRole("checkbox").count(), 6);
    await button(inbox, "选择当前页邮件").click(); assert.equal(await inbox.getByRole("checkbox", { checked: true }).count(), 6); await button(inbox, "清空选择").click();
    const verifyDetail = async scope => {
      await button(scope, "Sent projection 1").click(); const detail = scope.getByRole("region", { name: "普通邮件详情", exact: true });
      await detail.getByTestId("mail-body").filter({ hasText: "纯文本" }).waitFor(); assert.match(await detail.textContent(), /recipient@example.test/);
      assert.equal(await button(detail, "服务器加星标").count(), 1);
      assert.equal(await button(detail, "回复").count(), 1);
      assert.equal(await button(detail, "归档").count(), 1); return detail;
    };
    let detail = await verifyDetail(inbox);
    for (const [name, bytes, filename] of [["下载原始邮件", raw, "projection-raw.eml"], ["下载 part-0.bin", ATTACHMENT, "projection-attachment.bin"]]) {
      const waiting = page.waitForEvent("download"); await button(detail, name).click(); const download = await waiting, target = path.join(t.h.directory, filename);
      await download.saveAs(target); assert.deepEqual(await readFile(target), Buffer.from(bytes));
    }
    await page.screenshot({ path: path.join(t.h.directory, "folder-projection-unified-mobile.png"), fullPage: true });
    await button(inbox, "会话视图").click(); const conversations = inbox.getByRole("region", { name: "会话列表", exact: true });
    await conversations.getByRole("button", { name: /^打开会话 Sent projection/ }).click();
    const members = conversations.getByRole("region", { name: "会话邮件", exact: true }); await members.getByText("已加载 2 封会话邮件", { exact: true }).waitFor();
    detail = await verifyDetail(members); assert.match(await detail.textContent(), /Sent/);
    await button(page.getByRole("navigation"), "订阅邮件").click(); const subscriptions = page.getByRole("region", { name: "订阅管理", exact: true });
    const sentGroup = subscriptions.locator("li").filter({ has: page.getByText("Sent", { exact: true }) });
    await button(sentGroup, "查看订阅 Updates").click(); const subscriptionMembers = subscriptions.getByRole("region", { name: "订阅成员", exact: true });
    await subscriptionMembers.getByText("已加载 2 封订阅邮件", { exact: true }).waitFor(); await verifyDetail(subscriptionMembers);
    await page.screenshot({ path: path.join(t.h.directory, "folder-projection-subscription-mobile.png"), fullPage: true });
    assert.deepEqual(writes, []); await button(sentGroup, "隐藏订阅 Updates").click(); await subscriptions.getByText("已加载 2 个订阅", { exact: true }).waitFor();
    await subscriptions.getByLabel("订阅可见性", { exact: true }).selectOption("hidden"); await button(subscriptions, "恢复订阅 Updates").click();
    await subscriptions.getByText("暂无匹配的订阅", { exact: true }).waitFor(); assert.equal(expect(await t.list("subscriptions")).items.length, 3);
    assert.equal(writes.length, 2); assert.ok(writes.every(url => url.includes("/normal-subscriptions/")));
    assert.deepEqual(legacyReads, []); assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(t.opens.length, 4);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    console.log(`Folder projection Chrome evidence: ${t.h.directory}`);
  } catch (error) { if (page) { console.error(await page.locator("body").ariaSnapshot()); await page.screenshot({ path: path.join(t.h.directory, "folder-projection-failure.png"), fullPage: true }); } throw error; }
  finally { await browser?.close(); await t.close(); }
});

test("Chrome: a delayed aggregate folder detail cannot overwrite a different folder selection", { timeout: 90000 }, async () => {
  const t = await folderProjectionFixture({ browser: true }); let browser, release;
  try {
    await t.receiveAll(); const { page, inbox, ...rest } = await open(t); browser = rest.browser;
    let captured, settled; const entered = new Promise(resolve => { captured = resolve; }), done = new Promise(resolve => { settled = resolve; });
    const waiting = new Promise(resolve => { release = resolve; });
    await page.route(`**${t.folderPath("Sent")}/messages/*`, async route => {
      const response = await route.fetch(); captured(); await waiting; try { await route.fulfill({ response }); } finally { settled(); }
    });
    await button(inbox, "Sent projection 1").click(); await entered;
    await button(inbox, "&Ti1lhw- projection 1").click(); const detail = inbox.getByRole("region", { name: "普通邮件详情", exact: true });
    await detail.getByText("Content &Ti1lhw- projection 1", { exact: true }).waitFor(); release(); release = null; await done;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.match(await detail.textContent(), /Content &Ti1lhw- projection 1/); assert.doesNotMatch(await detail.textContent(), /Content Sent projection 1/);
  } finally { release?.(); await browser?.close(); await t.close(); }
});
