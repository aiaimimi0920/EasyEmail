import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { PASSWORD } from "./runtime-harness.mjs";
import { subscriptionsFixture, listMail, listHeaders, sync, subscriptions, hideSubscription, expect } from "./subscriptions-fixture.mjs";

const button = (p, name) => p.getByRole("button", { name, exact: true });
const field = (p, name) => p.getByLabel(name, { exact: true });

test("Chrome: subscription browsing is source-exact, complete, private and never automatically unsubscribes", { timeout: 120000 }, async () => {
  const f = await subscriptionsFixture(true); const { h, alice, bob, box } = f; let browser, page;
  try {
    f.f.messages.set(box.address, Array.from({ length: 28 }, (_, i) => listMail(box, i + 1, { subject: i === 0 ? "Needle" : `Member ${i}` })));
    for (let p = 1; p <= 3; p++) await sync(f, box, p);
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    const context = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
    const external = [], errors = [], writes = [];
    context.on("request", r => { if (!r.url().startsWith(h.baseUrl.origin)) external.push(r.url()); });
    await context.route("https://unsubscribe.example.test/**", route => route.fulfill({ status: 200, body: "Synthetic destination; no real unsubscribe" }));
    page = await context.newPage(); page.setDefaultTimeout(10000); page.on("pageerror", e => errors.push(e.message));
    page.on("request", r => { if (r.method() !== "GET") writes.push(r.url()); });
    await page.goto(h.baseUrl.href); await field(page, "用户名").fill(alice.username); await field(page, "密码").fill(PASSWORD); await button(page, "登录").click();
    await button(page, "订阅邮件").click(); const list = page.getByRole("region", { name: "订阅管理", exact: true });
    await list.getByText("28 封 · 28 封未读 · 版本 0", { exact: true }).waitFor();
    await field(list, "搜索订阅邮件").fill("Needle"); await button(list, "搜索订阅").click();
    await button(list, "查看订阅 Updates").click(); const members = page.getByRole("region", { name: "订阅成员", exact: true });
    await members.getByRole("status").filter({ hasText: "已加载 25 封订阅邮件" }).waitFor();
    await button(members, "加载更多订阅邮件").click(); await members.getByRole("status").filter({ hasText: "已加载 28 封订阅邮件" }).waitFor();
    await button(members, "Needle").click(); const detail = page.getByRole("article", { name: "邮件详情", exact: true });
    await button(detail, "标为已读").waitFor();
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM messages WHERE is_read=1").first("n"), 0);
    assert.equal(writes.filter(url => !url.endsWith("/auth/login")).length, 0); assert.deepEqual(external, []);
    await button(detail, "标为已读").click(); await list.getByText("28 封 · 27 封未读 · 版本 0", { exact: true }).waitFor();
    await button(detail, "回复").click(); await page.getByRole("heading", { name: "回复邮件", exact: true }).waitFor();
    assert.equal(await field(page, "收件地址").inputValue(), "noreply@example.test"); assert.equal(await field(page, "邮件主题").inputValue(), "Re: Needle");
    await button(page, "订阅邮件").click(); await button(list, "查看订阅 Updates").click();
    const methods = page.getByRole("region", { name: "退订方法", exact: true });
    await field(methods, "退订地址").selectOption({ index: 0 });
    page.once("dialog", dialog => dialog.dismiss()); await button(methods, "打开退订地址").click(); assert.deepEqual(external, []);
    page.once("dialog", dialog => dialog.accept());
    const popup = context.waitForEvent("page"); await button(methods, "打开退订地址").click(); const destination = await popup;
    await destination.waitForLoadState(); assert.equal(await destination.evaluate(() => window.opener === null), true); await destination.close();
    assert.equal(external.length, 1); assert.match(external[0], /^https:\/\/unsubscribe\.example\.test\//);
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(h.directory, "subscriptions-mobile.png"), fullPage: true });
    await button(page, "退出登录").click(); await field(page, "用户名").fill(bob.username); await field(page, "密码").fill(PASSWORD); await button(page, "登录").click();
    await button(page, "订阅邮件").click(); await list.getByText("暂无匹配的订阅", { exact: true }).waitFor();
    assert.equal(await button(list, "查看订阅 Updates").count(), 0); assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.deepEqual(errors, []); console.log(`Subscriptions browser evidence: ${h.directory}`);
  } catch (error) {
    if (page) { console.error(await page.locator("body").ariaSnapshot()); await page.screenshot({ path: path.join(h.directory, "subscriptions-failure.png"), fullPage: true }); }
    throw error;
  } finally { await browser?.close(); await f.close(); }
});

test("Chrome: subscription list pagination, explicit copy and browser-side URL validation do not create external requests", { timeout: 90000 }, async () => {
  const f = await subscriptionsFixture(true); const { h, alice, box } = f; let browser;
  try {
    f.f.messages.set(box.address, Array.from({ length: 26 }, (_, i) => listMail(box, i + 1, {
      subscription_headers: listHeaders({ listId: `List${i} <list${i}.example.test>` }),
    })));
    for (let p = 1; p <= 3; p++) await sync(f, box, p);
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    const page = await browser.newPage(); page.setDefaultTimeout(10000); const external = [];
    page.on("request", r => { if (!r.url().startsWith(h.baseUrl.origin)) external.push(r.url()); });
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: { writeText: async value => { window.syntheticCopied = value; } } }));
    await page.goto(h.baseUrl.href); await field(page, "用户名").fill(alice.username); await field(page, "密码").fill(PASSWORD); await button(page, "登录").click();
    await button(page, "订阅邮件").click(); const list = page.getByRole("region", { name: "订阅管理", exact: true });
    await list.getByRole("status").filter({ hasText: "已加载 25 个订阅" }).waitFor();
    await button(list, "加载更多订阅").click(); await list.getByRole("status").filter({ hasText: "已加载 26 个订阅" }).waitFor();
    await field(list, "搜索订阅邮件").fill("Newsletter 26"); await button(list, "搜索订阅").click();
    await list.getByRole("status").filter({ hasText: "已加载 1 个订阅" }).waitFor(); await button(list, "查看订阅 List25").click();
    const methods = page.getByRole("region", { name: "退订方法", exact: true });
    await field(methods, "退订地址").selectOption({ index: 1 }); await button(methods, "复制退订地址").click();
    await methods.getByText("已复制退订地址，尚未退订", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.syntheticCopied), "mailto:leave@example.test?subject=unsubscribe");
    await page.route("**/api/v1/subscriptions?**", async route => {
      const response = await route.fetch(), value = await response.json();
      for (const item of value.items) item.methods = ["javascript:alert(1)", "https://user:pass@example.test", "mailto:a@example.test?bcc=secret@example.test"];
      await route.fulfill({ response, json: value });
    });
    await button(list, "关闭订阅").click(); await button(list, "刷新订阅").click(); await button(list, "查看订阅 List25").click();
    await methods.getByText("没有可安全打开的退订地址", { exact: true }).waitFor();
    assert.equal(await button(methods, "打开退订地址").count(), 0); assert.deepEqual(external, []);
  } finally { await browser?.close(); await f.close(); }
});

test("Chrome: lost subscription preference response retains original key/body across navigation and never overwrites newer state", { timeout: 90000 }, async () => {
  const f = await subscriptionsFixture(true); const { h, alice, box } = f; let browser, page;
  try {
    f.f.messages.set(box.address, [listMail(box, 1)]); await sync(f);
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    page = await browser.newPage(); page.setDefaultTimeout(10000);
    await page.goto(h.baseUrl.href); await field(page, "用户名").fill(alice.username); await field(page, "密码").fill(PASSWORD); await button(page, "登录").click();
    await button(page, "订阅邮件").click(); const list = page.getByRole("region", { name: "订阅管理", exact: true });
    await button(list, "隐藏订阅 Updates").waitFor(); let lost = false; const writes = [];
    await page.route("**/api/v1/subscriptions/*/*", async route => {
      if (route.request().method() !== "PATCH") return route.continue();
      writes.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
      if (!lost) { lost = true; await route.fetch(); await route.abort("connectionfailed"); } else await route.continue();
    });
    await button(list, "隐藏订阅 Updates").click(); await button(list, "核对原订阅操作").waitFor();
    const key = await list.getByTestId("subscription-operation-key").textContent(); assert.equal(await button(list, "隐藏订阅 Updates").isDisabled(), true);
    const hidden = expect(await subscriptions(h, alice, "visibility=hidden")).items[0]; expect(await hideSubscription(h, alice, hidden, false));
    await button(page, "邮箱管理").click(); await button(page, "订阅邮件").click();
    assert.equal(await list.getByTestId("subscription-operation-key").textContent(), key);
    await button(list, "核对原订阅操作").click(); await list.getByText("1 封 · 1 封未读 · 版本 2", { exact: true }).waitFor();
    assert.deepEqual(writes[0], writes[1]); assert.equal(expect(await subscriptions(h, alice)).items[0].hidden, false);
    await page.unroute("**/api/v1/subscriptions/*/*");
    expect(await hideSubscription(h, alice, expect(await subscriptions(h, alice)).items[0], true));
    await button(list, "隐藏订阅 Updates").click(); await list.getByRole("alert").filter({ hasText: "订阅偏好已变化" }).waitFor();
    await list.getByText("暂无匹配的订阅", { exact: true }).waitFor(); await field(list, "订阅可见性").selectOption("hidden");
    await button(list, "恢复订阅 Updates").click(); await list.getByText("暂无匹配的订阅", { exact: true }).waitFor();
    await field(list, "订阅可见性").selectOption("active"); await list.getByText("1 封 · 1 封未读 · 版本 4", { exact: true }).waitFor();
    await page.getByRole("combobox", { name: "权限", exact: true }).selectOption("subscriptions"); await field(page, "名称").fill("subscription automation"); await button(page, "创建 Key").click();
    const token = await page.getByTestId("new-key").textContent(); expect(await h.request("/api/v1/subscriptions", { token, origin: null }));
    expect(await h.request(`/api/v1/mailboxes/${box.id}/sync`, { token, origin: null, method: "POST", body: {} }), 403);
  } finally { await browser?.close(); await f.close(); }
});
