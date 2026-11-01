import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { folderFlagsFixture } from "./normal-folder-flags-fixture.mjs";
import { mailboxData } from "./normal-folder-inbox-fixture.mjs";
import { PASSWORD } from "./runtime-harness.mjs";

const button = (p, name) => p.getByRole("button", { name, exact: true });
async function open(t) {
  const browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); page.setDefaultTimeout(15000);
    await page.goto(t.h.baseUrl.href); await page.getByLabel("用户名", { exact: true }).fill(t.alice.username);
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await button(page, "登录").click();
    await button(page.getByRole("navigation"), "普通邮箱").click();
    const normal = page.getByRole("region", { name: "普通邮箱", exact: true }); await button(normal, "普通邮箱").click();
    const catalog = normal.getByRole("region", { name: "服务器文件夹", exact: true }); await button(catalog, "查看 Sent 邮件").click();
    await button(catalog, "Sent mail").click();
    const detail = catalog.getByRole("region", { name: "普通邮件详情", exact: true }); await button(detail, "服务器加星标").waitFor();
    return { browser, page, detail };
  } catch (error) { await browser.close(); throw error; }
}
test("Chrome: held folder flag request keeps its path across navigation and all shared detail entry points", { timeout: 120000 }, async () => {
  const mailboxes = mailboxData(), sent = mailboxes.get("Sent");
  sent.messages.set(2, new TextEncoder().encode(new TextDecoder().decode(sent.messages.get(2)).replace("Subject: Sent mail",
    "Subject: Sent mail\r\nMessage-ID: <folder-flags@example.test>\r\nList-ID: Updates <updates.example.test>")));
  const t = await folderFlagsFixture({ browser: true, mailboxes }); let ui;
  try {
    await t.receive("INBOX"); ui = await open(t); const { page, detail } = ui, posts = [], reads = [], errors = [], external = [], opens = t.opens.length;
    page.on("pageerror", error => errors.push(error.message)); page.on("request", request => { if (!request.url().startsWith(t.h.baseUrl.origin)) external.push(request.url()); });
    await page.route(`**${t.path}`, async route => {
      if (route.request().method() !== "POST") return route.continue();
      posts.push({ url: route.request().url(), key: route.request().headers()["idempotency-key"], body: route.request().postData() });
      await route.fetch(); await route.abort("connectionfailed");
    });
    await page.route("**/remote-flag-operations/*", route => { reads.push(route.request().url()); return route.continue(); });
    await button(detail, "服务器加星标").click(); await button(page, "只读核对原远端操作").waitFor();
    const key = await page.getByTestId("remote-flags-request-key").textContent(); assert.equal(key, posts[0].key);
    await button(page.getByRole("navigation"), "联系人").click(); await button(page.getByRole("navigation"), "聚合收件箱").click();
    assert.equal(await page.getByTestId("remote-flags-request-key").textContent(), key);
    await button(page, "只读核对原远端操作").click(); await page.getByRole("status").filter({ hasText: "服务器标记已确认" }).waitFor();
    assert.equal(reads.length, 1); assert.ok(reads[0].endsWith(`${t.folderPath("Sent")}/remote-flag-operations/${key}`));
    const aggregate = page.getByRole("region", { name: "聚合邮件", exact: true }); await button(aggregate, "Sent mail").click();
    await button(aggregate, "服务器取消星标").waitFor();
    await button(aggregate, "会话视图").click(); await aggregate.getByRole("button", { name: /^打开会话 Sent mail/ }).click();
    const members = aggregate.getByRole("region", { name: "会话邮件", exact: true }); await button(members, "Sent mail").click(); await button(members, "服务器取消星标").waitFor();
    await button(page.getByRole("navigation"), "订阅邮件").click(); await button(page, "查看订阅 Updates").click();
    const subscription = page.getByRole("region", { name: "订阅成员", exact: true }); await button(subscription, "Sent mail").click(); await button(subscription, "服务器取消星标").waitFor();
    assert.equal(posts.length, 1); assert.equal(t.calls.filter(line => / STORE /.test(line)).length, 1); assert.equal(t.opens.length, opens + 1);
    assert.deepEqual((await t.messages("INBOX")).body.items[0].remoteFlags, ["\\Seen"]);
    assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(t.h.directory, "folder-flags-mobile.png"), fullPage: true }); console.log(`Folder flags Chrome evidence: ${t.h.directory}`);
  } catch (error) { if (ui) console.error(await ui.page.locator("body").ariaSnapshot()); throw error; }
  finally { await ui?.browser.close(); await t.close(); }
});
test("Chrome: wrong-folder receipts retain the original request and refresh only rediscovers unknown operations", { timeout: 120000 }, async () => {
  const t = await folderFlagsFixture({ browser: true }); let ui;
  try {
    ui = await open(t); const { page, detail } = ui, posts = [];
    await page.route(`**${t.path}`, async route => {
      if (route.request().method() !== "POST") return route.continue();
      posts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
      const response = await route.fetch(), body = await response.json(); body.operation.serverFolderId = "0".repeat(64); await route.fulfill({ response, json: body });
    });
    await button(detail, "服务器加星标").click(); await page.getByRole("alert").filter({ hasText: "服务器标记回执不匹配" }).waitFor();
    assert.equal(await page.getByTestId("remote-flags-request-key").textContent(), posts[0].key); assert.equal(await button(detail, "服务器加星标").isDisabled(), true);
    await page.route("**/remote-flag-operations/*", async route => {
      const response = await route.fetch(), body = await response.json(); body.operation.serverFolderId = "0".repeat(64); await route.fulfill({ response, json: body });
    });
    await button(page, "只读核对原远端操作").click(); await page.getByRole("alert").filter({ hasText: "服务器标记回执不匹配" }).waitFor();
    assert.equal(await page.getByTestId("remote-flags-request-key").textContent(), posts[0].key);
    await page.unroute("**/remote-flag-operations/*");
    await button(page, "只读核对原远端操作").click(); await page.getByRole("status").filter({ hasText: "服务器标记已确认" }).waitFor();
    await page.unroute(`**${t.path}`);
    await page.route(`**${t.path}`, async route => {
      const response = await route.fetch(), body = await response.json(); body.operation.serverFolderId = "0".repeat(64); await route.fulfill({ response, json: body });
    });
    await page.reload();
    await button(page.getByRole("navigation"), "普通邮箱").click();
    const normal = page.getByRole("region", { name: "普通邮箱", exact: true }); await button(normal, "普通邮箱").click();
    const catalog = normal.getByRole("region", { name: "服务器文件夹", exact: true }); await button(catalog, "查看 Sent 邮件").click(); await button(catalog, "Sent mail").click();
    const current = catalog.getByRole("region", { name: "普通邮件详情", exact: true });
    await current.getByRole("alert").filter({ hasText: "服务器标记回执不匹配" }).waitFor(); assert.equal(await button(current, "服务器取消星标").isDisabled(), true);
    await page.unroute(`**${t.path}`); await button(current, "只读刷新远端操作记录").click();
    await current.getByRole("status").filter({ hasText: "服务器标记核对时间" }).waitFor();
    t.scenario({ storeResponse: tag => `${tag} NO synthetic refusal\r\n` }); await button(current, "服务器取消星标").click();
    await current.getByRole("alert").filter({ hasText: "原操作结果未知" }).waitFor(); const stores = t.calls.filter(line => / STORE /.test(line)).length;
    await page.reload(); await button(page.getByRole("navigation"), "普通邮箱").click(); await button(normal, "普通邮箱").click();
    await button(catalog, "查看 Sent 邮件").click(); await button(catalog, "Sent mail").click();
    const ack = current.getByLabel("我已核对服务器状态，知悉原操作结果仍未知", { exact: true }); await ack.waitFor();
    assert.equal(await button(current, "服务器取消星标").isDisabled(), true); assert.equal(t.calls.filter(line => / STORE /.test(line)).length, stores);
    await ack.check(); t.scenario({}); await button(current, "服务器取消星标").click();
    await button(current, "服务器加星标").waitFor(); assert.equal(t.calls.filter(line => / STORE /.test(line)).length, stores + 1);
  } catch (error) { if (ui) console.error(await ui.page.locator("body").ariaSnapshot()); throw error; }
  finally { await ui?.browser.close(); await t.close(); }
});
