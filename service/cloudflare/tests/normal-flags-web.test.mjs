import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { normalFlagsFixture } from "./normal-flags-access-fixture.mjs";
import { normalListMail } from "./normal-subscriptions-fixture.mjs";
import { PASSWORD } from "./runtime-harness.mjs";

const button = (p, name) => p.getByRole("button", { name, exact: true });
async function open(t) {
  const browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); page.setDefaultTimeout(10000);
    await page.goto(t.h.baseUrl.href); await page.getByLabel("用户名", { exact: true }).fill(t.alice.username);
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await button(page, "登录").click();
    await page.getByRole("navigation").getByRole("button", { name: "普通邮箱", exact: true }).click();
    const region = page.getByRole("region", { name: "普通邮箱", exact: true }); await button(region, "普通邮箱").click();
    await button(region, t.item.subject).click();
    return { browser, page, region, detail: region.getByRole("region", { name: "普通邮件详情", exact: true }) };
  } catch (error) { await browser.close(); throw error; }
}
test("Chrome: remote flag receipts survive navigation/lost response and shared details retain local-only controls", { timeout: 120000 }, async () => {
  const t = await normalFlagsFixture({ browser: true, messages: new Map([[1, normalListMail(1, { subject: "Remote flags" })]]), uidNext: 2 });
  let browser, page;
  try {
    let region, detail; ({ browser, page, region, detail } = await open(t));
    const errors = [], writes = [], external = []; page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (!request.url().startsWith(t.h.baseUrl.origin)) external.push(request.url()); });
    await button(detail, "服务器加星标").waitFor(); const initialOpens = t.opens.length;
    await button(detail, "标为已读").click(); await detail.waitFor({ state: "hidden" });
    await button(region, "Remote flags").click(); await button(detail, "标为未读").waitFor(); assert.equal(t.opens.length, initialOpens);
    await page.route(`**${t.path}`, async route => {
      if (route.request().method() !== "POST") return route.continue();
      writes.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
      await route.fetch(); await route.abort("connectionfailed");
    });
    await button(detail, "服务器加星标").click(); await button(page, "只读核对原远端操作").waitFor();
    const key = await page.getByTestId("remote-flags-request-key").textContent(); assert.equal(key, writes[0].key);
    await button(page.getByRole("navigation"), "联系人").click(); await button(page.getByRole("navigation"), "聚合收件箱").click();
    assert.equal(await page.getByTestId("remote-flags-request-key").textContent(), key);
    await button(page, "只读核对原远端操作").click(); await page.getByRole("status").filter({ hasText: "服务器标记已确认" }).waitFor();
    assert.equal(writes.length, 1); assert.equal(t.calls.filter(line => / STORE /.test(line)).length, 1);
    const aggregate = page.getByRole("region", { name: "聚合邮件", exact: true });
    await button(aggregate, "Remote flags").click(); await button(aggregate, "服务器取消星标").waitFor();
    await button(aggregate, "会话视图").click(); await aggregate.getByRole("button", { name: /^打开会话 / }).click();
    const members = aggregate.getByRole("region", { name: "会话邮件", exact: true }); await button(members, "Remote flags").click();
    await button(members, "服务器取消星标").waitFor();
    await button(page.getByRole("navigation"), "订阅邮件").click(); await button(page, "查看订阅 Updates").click();
    const subscription = page.getByRole("region", { name: "订阅成员", exact: true }); await button(subscription, "Remote flags").click();
    await button(subscription, "服务器取消星标").waitFor(); assert.equal(t.opens.length, initialOpens + 1);
    await page.getByRole("combobox", { name: "权限", exact: true }).selectOption("normal-remote-flags");
    await page.getByLabel("名称", { exact: true }).fill("remote flags profile"); await button(page, "创建 Key").click();
    const token = await page.getByTestId("new-key").textContent();
    assert.equal((await t.latest({ cookie: undefined, token, origin: null })).status, 200);
    assert.equal((await t.receive(crypto.randomUUID(), 1, { cookie: undefined, token, origin: null })).status, 403);
    await button(page, "隐藏").click();
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(t.h.directory, "normal-flags-shared-mobile.png"), fullPage: true });
    assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    console.log(`Remote flags shared Chrome evidence: ${t.h.directory}`);
  } catch (error) { if (page) { console.error(await page.locator("body").ariaSnapshot()); await page.screenshot({ path: path.join(t.h.directory, "normal-flags-web-failure.png"), fullPage: true }); } throw error; }
  finally { try { await browser?.close(); } finally { await t.close(); } }
});
test("Chrome: mismatched success and missing receipt retain the exact original request instead of inventing a new intent", { timeout: 90000 }, async () => {
  const t = await normalFlagsFixture({ browser: true, messages: new Map([[1, normalListMail(1, { subject: "Receipt mismatch" })]]), uidNext: 2 });
  let browser, page;
  try {
    let detail; ({ browser, page, detail } = await open(t)); await button(detail, "服务器加星标").waitFor();
    let forged = true; const writes = [], opens = t.opens.length;
    await page.route(`**${t.path}`, async route => {
      if (route.request().method() !== "POST") return route.continue();
      writes.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
      return forged ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ operation: { state: "confirmed", accountId: "wrong" } }) }) : route.continue();
    });
    await button(detail, "服务器加星标").click(); await page.getByRole("alert").filter({ hasText: "服务器标记回执不匹配" }).waitFor();
    await button(page, "只读核对原远端操作").click(); await page.getByRole("alert").filter({ hasText: "not_found" }).waitFor();
    assert.equal(t.opens.length, opens); assert.equal(await page.getByTestId("remote-flags-request-key").textContent(), writes[0].key);
    forged = false; await button(page, "重送原请求（不重复执行）").click();
    await page.getByRole("status").filter({ hasText: "服务器标记已确认" }).waitFor();
    assert.equal(writes.length, 2); assert.deepEqual(writes[0], writes[1]); assert.equal(t.calls.filter(line => / STORE /.test(line)).length, 1);
  } finally { try { await browser?.close(); } finally { await t.close(); } }
});
test("Chrome: proxy 408/429 and contradictory failed receipts cannot release a dispatched request key", { timeout: 120000 }, async () => {
  const t = await normalFlagsFixture({ browser: true, messages: new Map([[1, normalListMail(1, { subject: "Proxy outcomes" })]]), uidNext: 2 });
  let browser, page;
  try {
    let detail; ({ browser, page, detail } = await open(t)); await button(detail, "服务器加星标").waitFor();
    let mode = 408, posted = "", stores = 0;
    await page.route(`**${t.path}`, async route => {
      if (route.request().method() !== "POST") return route.continue();
      posted = route.request().headers()["idempotency-key"];
      const response = await route.fetch(), body = await response.json();
      if (mode === "failed") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        operation: { ...body.operation, state: "failed", remoteFlags: null, error: "remote_flags_target_changed" } }) });
      return route.fulfill({ status: mode, contentType: "application/json", body: JSON.stringify({ error: { code: "request_timeout" } }) });
    });
    for (mode of [408, 429, "failed"]) {
      const name = mode === 429 ? "服务器取消星标" : "服务器加星标";
      await button(detail, name).click(); await button(page, "只读核对原远端操作").waitFor();
      assert.equal(await page.getByTestId("remote-flags-request-key").textContent(), posted);
      assert.equal(await button(detail, name).isDisabled(), true);
      await button(page, "只读核对原远端操作").click();
      await page.getByRole("status").filter({ hasText: "服务器标记已确认" }).waitFor();
      await button(detail, mode === 429 ? "服务器加星标" : "服务器取消星标").waitFor();
      assert.equal(t.calls.filter(line => / STORE /.test(line)).length, ++stores);
    }
  } finally { try { await browser?.close(); } finally { await t.close(); } }
});
test("Chrome: unknown remote outcomes never retry implicitly and another intent needs explicit acknowledgement", { timeout: 90000 }, async () => {
  const t = await normalFlagsFixture({ browser: true, messages: new Map([[1, normalListMail(1, { subject: "Remote unknown" })]]), uidNext: 2 }); let browser, page;
  try {
    let detail; ({ browser, page, detail } = await open(t)); await button(detail, "服务器加星标").waitFor();
    t.scenario({ storeResponse: tag => `${tag} NO synthetic refusal\r\n` });
    await button(detail, "服务器加星标").click(); await detail.getByRole("alert").filter({ hasText: "原操作结果未知" }).waitFor();
    assert.equal(await button(detail, "服务器加星标").isDisabled(), true);
    const stores = t.calls.filter(line => / STORE /.test(line)).length;
    await page.reload(); await button(page.getByRole("navigation"), "普通邮箱").click();
    const region = page.getByRole("region", { name: "普通邮箱", exact: true }); await button(region, "普通邮箱").click(); await button(region, t.item.subject).click();
    detail = region.getByRole("region", { name: "普通邮件详情", exact: true });
    const confirmation = detail.getByLabel("我已核对服务器状态，知悉原操作结果仍未知", { exact: true }); await confirmation.check();
    t.scenario({}); await button(detail, "服务器加星标").click(); await button(detail, "服务器取消星标").waitFor();
    assert.equal(t.calls.filter(line => / STORE /.test(line)).length, stores + 1);
    assert.equal(await button(detail, "标为已读").count(), 1, "remote action does not mark platform state");
    await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(t.h.directory, "normal-flags-confirmed-mobile.png"), fullPage: true });
    console.log(`Remote flags ambiguity Chrome evidence: ${t.h.directory}`);
  } finally { try { await browser?.close(); } finally { await t.close(); } }
});
