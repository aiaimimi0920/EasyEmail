import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { PASSWORD } from "./runtime-harness.mjs";
import { conversationFixture, threadMail, sync } from "./conversations-fixture.mjs";

const button = (p, name) => p.getByRole("button", { name, exact: true });
const field = (p, name) => p.getByLabel(name, { exact: true });

test("Chrome: conversation search expands complete cached groups, paginates members and keeps reads/replies/flags source-exact", { timeout: 120000 }, async () => {
  const f = await conversationFixture(true); const { h, alice, bob, box } = f; let browser, page;
  try {
    const rows = Array.from({ length: 28 }, (_, i) => threadMail(box, i + 1, `<web${i}@example.test>`, "<web-root@example.test>", i === 0 ? "Needle" : `Member ${i}`));
    f.f.messages.set(box.address, rows); for (let p = 1; p <= 3; p++) await sync(f, box, p);
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); page.setDefaultTimeout(10000);
    const errors = [], external = [], writes = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (!request.url().startsWith(h.baseUrl.origin)) external.push(request.url()); if (request.method() !== "GET") writes.push(request.url()); });
    await page.goto(h.baseUrl.href); await field(page, "用户名").fill(alice.username); await field(page, "密码").fill(PASSWORD); await button(page, "登录").click();
    await button(page, "聚合收件箱").click(); await page.getByRole("combobox", { name: "邮件来源", exact: true }).selectOption("temporary"); await button(page, "搜索邮件").click(); assert.equal(await button(page, "逐封视图").getAttribute("aria-pressed"), "true");
    await button(page, "会话视图").click(); const list = page.getByRole("region", { name: "会话列表", exact: true });
    await list.getByText("28 封 · 28 封未读 · 邮件头关联", { exact: true }).waitFor();
    await field(page, "搜索缓存邮件").fill("Needle"); await button(page, "搜索邮件").click();
    await list.getByText("28 封 · 28 封未读 · 邮件头关联", { exact: true }).waitFor();
    await button(list, "打开会话 Member 27").click(); const members = page.getByRole("region", { name: "会话邮件", exact: true });
    await members.getByRole("status").filter({ hasText: "已加载 25 封会话邮件" }).waitFor();
    await button(members, "加载更多会话邮件").click(); await members.getByRole("status").filter({ hasText: "已加载 28 封会话邮件" }).waitFor();
    await button(members, "Needle").click(); const detail = page.getByRole("article", { name: "邮件详情", exact: true });
    await button(detail, "标为已读").waitFor();
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM messages WHERE mailbox_id=? AND is_read=1").bind(box.id).first("n"), 0);
    assert.equal(writes.filter(url => !url.endsWith("/auth/login")).length, 0, "Browsing must not write flags or send");
    await button(detail, "标为已读").click(); await list.getByText("28 封 · 27 封未读 · 邮件头关联", { exact: true }).waitFor();
    await button(members, "加载更多会话邮件").click(); await button(members, "Member 27").click(); await detail.getByRole("heading", { name: "Member 27", exact: true }).waitFor();
    await button(detail, "回复").click(); await page.getByRole("heading", { name: "回复邮件", exact: true }).waitFor();
    await field(page, "发件邮箱").locator(`option[value="${box.id}"]`).waitFor({ state: "attached" });
    assert.equal(await field(page, "邮件主题").inputValue(), "Re: Member 27"); assert.equal(await field(page, "收件地址").inputValue(), "noreply@example.test");
    assert.equal(await field(page, "发件邮箱").inputValue(), box.id); assert.equal(writes.some(url => url.includes("/outgoing")), false);
    await button(page, "聚合收件箱").click(); await page.getByRole("combobox", { name: "邮件来源", exact: true }).selectOption("temporary"); await button(page, "搜索邮件").click(); await button(page, "逐封视图").click(); await button(page, "Needle").waitFor();
    await button(page, "会话视图").click(); await list.getByText("28 封 · 27 封未读 · 邮件头关联", { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(h.directory, "conversations-mobile.png"), fullPage: true });
    await button(page, "退出登录").click(); await field(page, "用户名").fill(bob.username); await field(page, "密码").fill(PASSWORD); await button(page, "登录").click();
    await button(page, "聚合收件箱").click(); await page.getByRole("combobox", { name: "邮件来源", exact: true }).selectOption("temporary"); await button(page, "搜索邮件").click(); await button(page, "会话视图").click(); await list.getByText("暂无匹配的会话", { exact: true }).waitFor();
    assert.equal(await button(list, "打开会话 Member 27").count(), 0);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0); assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log(`Conversations browser evidence: ${h.directory}`);
  } catch (error) {
    if (page) { console.error(await page.locator("body").ariaSnapshot()); await page.screenshot({ path: path.join(h.directory, "conversations-failure.png"), fullPage: true }); }
    throw error;
  } finally { await browser?.close(); await f.close(); }
});

test("Chrome: index-pending and failed refresh never display stale conversation counts and recover only on explicit refresh", { timeout: 60000 }, async () => {
  const f = await conversationFixture(true); const { h, alice, box } = f; let browser, page;
  try {
    f.f.messages.set(box.address, [threadMail(box, 1, "<one@example.test>")]); await sync(f);
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    page = await browser.newPage(); page.setDefaultTimeout(10000);
    await page.goto(h.baseUrl.href); await field(page, "用户名").fill(alice.username); await field(page, "密码").fill(PASSWORD); await button(page, "登录").click();
    let mode = "conversation_index_pending", reads = 0;
    await page.route("**/api/v1/conversations?**", route => { reads++; return mode ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: mode } }) }) : route.continue(); });
    await button(page, "聚合收件箱").click(); await page.getByRole("combobox", { name: "邮件来源", exact: true }).selectOption("temporary"); await button(page, "搜索邮件").click(); await button(page, "会话视图").click();
    const list = page.getByRole("region", { name: "会话列表", exact: true }); await list.getByRole("alert").waitFor(); assert.equal(reads, 1);
    mode = ""; await button(list, "刷新会话列表").click(); await button(list, "打开会话 Thread").waitFor();
    mode = "conversation_index_failed"; await button(list, "刷新会话列表").click(); await list.getByRole("alert").waitFor();
    assert.equal(await button(list, "打开会话 Thread").count(), 0, "Failed reindex cannot present an old successful snapshot as current");
    mode = ""; await button(list, "刷新会话列表").click(); await button(list, "打开会话 Thread").waitFor(); assert.equal(reads, 4);
  } finally { await browser?.close(); await f.close(); }
});
