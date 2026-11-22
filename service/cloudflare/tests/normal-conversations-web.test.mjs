import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { normalConversationFixture, normalThreadMail } from "./normal-conversations-fixture.mjs";
import { PASSWORD, seedMailbox } from "./runtime-harness.mjs";

const button = (p, name) => p.getByRole("button", { name, exact: true });
async function open(t) {
  const browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); page.setDefaultTimeout(10000);
  await page.goto(t.h.baseUrl.href); await page.getByLabel("用户名", { exact: true }).fill(t.alice.username);
  await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await button(page, "登录").click();
  await page.getByRole("navigation").getByRole("button", { name: "聚合收件箱", exact: true }).click();
  return { browser, page, inbox: page.getByRole("region", { name: "聚合邮件", exact: true }) };
}

test("Chrome: all/normal conversations paginate complete groups, open source-exact protected readers and refresh platform state without IMAP/send", { timeout: 180000 }, async () => {
  const messages = new Map(Array.from({ length: 26 }, (_, i) => [i + 1, normalThreadMail(`<web${i}@example.test>`, "<web-root@example.test>", i === 0 ? "Needle" : `Member ${i}`)]));
  const t = await normalConversationFixture({ browser: true, messages }); let browser, page;
  try {
    await t.receiveAll();
    const row = await t.h.db.prepare("SELECT * FROM normal_inbox_messages ORDER BY id DESC LIMIT 1").first(), box = await seedMailbox(t.h, t.alice.id, "web-collision@example.test");
    await t.h.db.prepare(`INSERT INTO messages(id,user_id,mailbox_id,remote_id,fingerprint,sender,recipient,subject,text_body,html_body,attachments,received_at,observed_at)
      VALUES (?,?,?,'web-collision','web-collision','sender@example.test','web-collision@example.test','Temporary only','','','[]',?,?)`).bind(row.id, t.alice.id, box, row.received_at, row.received_at).run();
    let inbox; ({ browser, page, inbox } = await open(t)); const errors = [], external = [], writes = [], memberPaths = [];
    page.on("pageerror", error => errors.push(error.message)); page.on("request", request => {
      if (!request.url().startsWith(t.h.baseUrl.origin)) external.push(request.url());
      if (request.method() !== "GET") writes.push(request.url());
      if (/\/conversations\/[^/]+\/messages/.test(request.url())) memberPaths.push(new URL(request.url()));
    });
    await button(inbox, "会话视图").click(); const list = inbox.getByRole("region", { name: "会话列表", exact: true });
    await list.getByText("26 封 · 26 封未读 · 邮件头关联", { exact: true }).waitFor();
    await button(list, "打开会话 Temporary only").click(); const members = inbox.getByRole("region", { name: "会话邮件", exact: true });
    await button(members, "Temporary only").click(); await members.getByRole("article", { name: "邮件详情", exact: true }).waitFor();
    assert.equal(memberPaths.at(-1).searchParams.get("sources"), "temporary");
    await button(members, "关闭会话").click();
    await inbox.getByLabel("搜索缓存邮件", { exact: true }).fill("Needle"); await button(inbox, "搜索邮件").click();
    await list.getByText("26 封 · 26 封未读 · 邮件头关联", { exact: true }).waitFor();
    assert.equal(await button(inbox, "会话视图").getAttribute("aria-pressed"), "true");
    await list.getByRole("button", { name: /^打开会话 / }).click();
    await members.getByRole("status").filter({ hasText: "已加载 25 封会话邮件" }).waitFor();
    await button(members, "加载更多会话邮件").click(); await members.getByRole("status").filter({ hasText: "已加载 26 封会话邮件" }).waitFor();
    assert.equal(memberPaths.at(-1).searchParams.get("sources"), "normal"); assert.equal(memberPaths.at(-1).searchParams.get("accountId"), t.id);
    await button(members, "Needle").click(); const detail = members.getByRole("region", { name: "普通邮件详情", exact: true });
    await detail.getByText("Content Needle", { exact: false }).waitFor(); assert.equal(await button(detail, "回复").count(), 1);
    assert.deepEqual(writes, []); assert.equal(t.opens.length, 9);
    await button(detail, "标为已读").click(); await list.getByText("26 封 · 25 封未读 · 邮件头关联", { exact: true }).waitFor();
    await button(detail, "加星标").click(); await list.getByText("26 封 · 25 封未读 · 星标 · 邮件头关联", { exact: true }).waitFor();
    await inbox.getByRole("combobox", { name: "邮件来源", exact: true }).selectOption("normal"); await button(inbox, "搜索邮件").click();
    await list.getByText("26 封 · 25 封未读 · 星标 · 邮件头关联", { exact: true }).waitFor();
    assert.equal(await button(list, "打开会话 Temporary only").count(), 0);
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(t.h.directory, "normal-conversations-mobile.png"), fullPage: true });
    assert.equal(writes.length, 2); assert.ok(writes.every(url => url.endsWith(`/normal-accounts/${t.id}/messages/organize`)));
    assert.equal(t.opens.length, 9); assert.equal(t.calls.some(line => /STORE|EXPUNGE|COPY|MOVE/.test(line)), false);
    assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  } catch (error) { if (page) { console.error(await page.locator("body").ariaSnapshot()); await page.screenshot({ path: path.join(t.h.directory, "normal-conversations-failure.png"), fullPage: true }); } throw error; }
  finally { await browser?.close(); await t.close(); }
});

test("Chrome: ordinary conversation pending/failure clears stale results and retries only on explicit refresh", { timeout: 90000 }, async () => {
  const t = await normalConversationFixture({ browser: true }); let browser, page;
  try {
    await t.receiveAll(); let inbox; ({ browser, page, inbox } = await open(t)); let mode = "normal_conversation_index_pending", reads = 0;
    await page.route("**/api/v1/conversations?**", route => { reads++; return mode
      ? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: mode } }) }) : route.continue(); });
    await inbox.getByRole("combobox", { name: "邮件来源", exact: true }).selectOption("normal"); await button(inbox, "搜索邮件").click(); await button(inbox, "会话视图").click();
    const list = inbox.getByRole("region", { name: "会话列表", exact: true }); await list.getByRole("alert").filter({ hasText: "正在建立普通邮件会话索引" }).waitFor(); assert.equal(reads, 1);
    mode = ""; await button(list, "刷新会话列表").click(); await list.getByText("已加载 2 个会话", { exact: true }).waitFor();
    mode = "normal_content_unavailable"; await button(list, "刷新会话列表").click(); await list.getByRole("alert").waitFor();
    assert.equal(await list.getByRole("button", { name: /^打开会话 / }).count(), 0);
    mode = ""; await button(list, "刷新会话列表").click(); await list.getByText("已加载 2 个会话", { exact: true }).waitFor();
    assert.equal(reads, 4); assert.equal(t.opens.length, 1);
  } finally { await browser?.close(); await t.close(); }
});
