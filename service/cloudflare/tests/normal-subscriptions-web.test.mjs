import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { normalSubscriptionsFixture, normalListMail, expect } from "./normal-subscriptions-fixture.mjs";
import { PASSWORD, seedMailbox } from "./runtime-harness.mjs";

const button = (p, name) => p.getByRole("button", { name, exact: true });
async function open(t) {
  const browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); page.setDefaultTimeout(10000);
  await page.goto(t.h.baseUrl.href); await page.getByLabel("用户名", { exact: true }).fill(t.alice.username);
  await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await button(page, "登录").click(); await button(page, "订阅邮件").click();
  return { browser, page, list: page.getByRole("region", { name: "订阅管理", exact: true }) };
}
test("Chrome: mixed subscription sources dispatch protected readers, paginate whole ordinary groups and refresh local flags without IMAP/unsubscribe", { timeout: 180000 }, async () => {
  const messages = new Map(Array.from({ length: 26 }, (_, i) => [i + 1, normalListMail(i + 1, { subject: i === 0 ? "Needle ordinary" : `Member ${i}` })]));
  const t = await normalSubscriptionsFixture({ browser: true, messages }); let browser, page;
  try {
    await t.receiveAll(); const normal = expect(await t.list()).items[0], row = await t.h.db.prepare("SELECT * FROM normal_inbox_messages WHERE id=?").bind(normal.latest.id).first();
    const box = await seedMailbox(t.h, t.alice.id, "web-subscription@example.test");
    await t.h.db.prepare(`INSERT INTO messages(id,user_id,mailbox_id,remote_id,fingerprint,sender,recipient,subject,text_body,html_body,attachments,received_at,observed_at)
      VALUES (?,?,?,'same','same','sender@example.test','web-subscription@example.test','Temporary only','','','[]',?,?)`).bind(row.id, t.alice.id, box, row.received_at, row.received_at).run();
    await t.h.db.prepare("INSERT INTO message_subscriptions VALUES (?,?,?,?,?,?,?,?,?)").bind(t.alice.id, box, row.id, normal.id, "updates.example.test", "Temporary Updates", "sender@example.test", "[]", 0).run();
    let list; ({ browser, page, list } = await open(t)); const writes = [], external = [], errors = [], members = [];
    page.on("pageerror", error => errors.push(error.message)); page.on("request", request => {
      if (request.method() !== "GET") writes.push(request.url()); if (!request.url().startsWith(t.h.baseUrl.origin)) external.push(request.url());
      if (/\/(?:normal-)?subscriptions\/[^/]+\/[^/]+\/messages/.test(request.url())) members.push(new URL(request.url()));
    });
    await list.getByText("26 封 · 26 封未读 · 版本 0", { exact: true }).waitFor();
    await button(list, "查看订阅 Temporary Updates").click(); const group = page.getByRole("region", { name: "订阅成员", exact: true });
    await button(group, "Temporary only").click(); await group.getByRole("article", { name: "邮件详情", exact: true }).waitFor();
    assert.match(members.at(-1).pathname, /^\/api\/v1\/subscriptions\//); await button(group, "关闭订阅").click();
    await list.getByLabel("搜索订阅邮件", { exact: true }).fill("Needle ordinary"); await button(list, "搜索订阅").click(); await button(list, "查看订阅 Updates").click();
    await group.getByText("已加载 25 封订阅邮件", { exact: true }).waitFor(); await button(group, "加载更多订阅邮件").click(); await group.getByText("已加载 26 封订阅邮件", { exact: true }).waitFor();
    assert.equal(members.at(-1).searchParams.get("epochId"), normal.epochId); assert.equal(members.at(-1).searchParams.has("sources"), false);
    await button(group, "Needle ordinary").click(); const detail = group.getByRole("region", { name: "普通邮件详情", exact: true });
    await detail.getByText("Content Needle ordinary", { exact: false }).waitFor(); assert.equal(await button(detail, "回复").count(), 1);
    assert.deepEqual(writes, []); await button(detail, "标为已读").click(); await list.getByText("26 封 · 25 封未读 · 版本 0", { exact: true }).waitFor();
    await detail.getByRole("button", { name: "加星标", exact: true }).click(); await button(detail, "取消星标").waitFor();
    await list.getByLabel("订阅来源", { exact: true }).selectOption("temporary"); await list.getByText("暂无匹配的订阅", { exact: true }).waitFor();
    await list.getByLabel("订阅来源", { exact: true }).selectOption("normal"); await button(list, "查看订阅 Updates").waitFor();
    await page.getByRole("combobox", { name: "权限", exact: true }).selectOption("unified-subscriptions"); await page.getByLabel("名称", { exact: true }).fill("ordinary subscriptions"); await button(page, "创建 Key").click();
    const token = await page.getByTestId("new-key").textContent(); expect(await t.list(undefined, { cookie: undefined, token, origin: null }));
    expect(await t.h.request(`${t.base}/sync`, { method: "POST", token, origin: null, body: { expectedRevision: 1 }, headers: { "idempotency-key": crypto.randomUUID() } }), 403);
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(t.h.directory, "normal-subscriptions-mobile.png"), fullPage: true });
    assert.equal(t.opens.length, 9); assert.equal(t.calls.some(line => /STORE|EXPUNGE|COPY|MOVE/.test(line)), false); assert.deepEqual(external, []); assert.deepEqual(errors, []);
    assert.equal(writes.filter(url => url.endsWith("/messages/organize")).length, 2); assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  } catch (error) { if (page) { console.error(await page.locator("body").ariaSnapshot()); await page.screenshot({ path: path.join(t.h.directory, "normal-subscriptions-failure.png"), fullPage: true }); } throw error; }
  finally { await browser?.close(); await t.close(); }
});

test("Chrome: uncertain ordinary subscription writes retain exact key/body across navigation and use read-only receipt reconciliation", { timeout: 90000 }, async () => {
  const t = await normalSubscriptionsFixture({ browser: true }); let browser;
  try {
    await t.receiveAll(); const { page, list, ...rest } = await open(t); browser = rest.browser;
    await button(list, "隐藏订阅 Updates").waitFor(); const writes = []; let fail = "lost", reads = 0;
    await page.route("**/api/v1/normal-subscriptions/*/*", async route => {
      if (route.request().method() !== "PATCH") return route.continue();
      writes.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData(), path: new URL(route.request().url()).pathname });
      if (fail === "lost") { await route.fetch(); return route.abort("connectionfailed"); }
      return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { code: "forbidden" } }) });
    });
    await page.route("**/api/v1/normal-subscription-operations/*", route => { reads++; return route.continue(); });
    await button(list, "隐藏订阅 Updates").click(); await button(list, "核对原订阅操作").waitFor(); const key = await list.getByTestId("subscription-operation-key").textContent();
    fail = "denied"; await button(list, "核对原订阅操作").click(); await list.getByRole("alert").filter({ hasText: "forbidden" }).waitFor();
    assert.equal(await list.getByTestId("subscription-operation-key").textContent(), key); assert.equal(await list.getByLabel("订阅来源", { exact: true }).isDisabled(), true);
    const saved = expect(await t.list("sources=normal&visibility=hidden")).items[0]; expect(await t.hide(saved, false));
    await button(page, "邮箱管理").click(); await button(page, "订阅邮件").click(); assert.equal(await list.getByTestId("subscription-operation-key").textContent(), key);
    await button(list, "只读核对原订阅操作").click(); await list.getByText("2 封 · 2 封未读 · 版本 2", { exact: true }).waitFor();
    assert.deepEqual(writes[0], writes[1]); assert.equal(writes.length, 2); assert.equal(reads, 1); assert.equal(expect(await t.list()).items[0].hidden, false); assert.equal(t.opens.length, 1);
  } finally { await browser?.close(); await t.close(); }
});

test("Chrome: ordinary subscription index errors clear stale members/methods without automatic retry", { timeout: 90000 }, async () => {
  const t = await normalSubscriptionsFixture({ browser: true }); let browser;
  try {
    await t.receiveAll(); const { page, list, ...rest } = await open(t); browser = rest.browser;
    await button(list, "查看订阅 Updates").click(); await list.getByRole("region", { name: "退订方法", exact: true }).waitFor();
    let mode = "normal_subscription_index_pending", reads = 0;
    await page.route("**/api/v1/subscriptions?**", route => { reads++; return mode ? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: mode } }) }) : route.continue(); });
    await button(list, "刷新订阅").click(); await list.getByRole("alert").filter({ hasText: "正在建立普通邮件订阅索引" }).waitFor();
    assert.equal(await list.getByRole("region", { name: "订阅成员", exact: true }).count(), 0); assert.equal(reads, 1);
    mode = ""; await button(list, "刷新订阅").click(); await button(list, "查看订阅 Updates").waitFor(); assert.equal(reads, 2); assert.equal(t.opens.length, 1);
  } finally { await browser?.close(); await t.close(); }
});
