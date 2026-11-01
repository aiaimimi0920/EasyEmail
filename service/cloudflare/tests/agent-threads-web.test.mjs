import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { PASSWORD } from "./runtime-harness.mjs";
import { agentThreadsFixture } from "./agent-threads-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";

const executablePath = process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
async function open(page, t) {
  await page.goto(t.h.baseUrl.href); await page.getByLabel("用户名", { exact: true }).fill(t.alice.username);
  await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("navigation").getByRole("button", { name: "Agent 线程", exact: true }).click();
  return page.getByRole("region", { name: "Agent 线程", exact: true });
}

test("Chrome: thread filter, detail, explicit completion/archive/restore, least-privileged Key and mobile layout", { timeout: 90000 }, async () => {
  const t = await agentThreadsFixture({ browser: true }); let browser, page;
  try {
    const task = await t.task({ submitted: false, subject: "线程状态浏览器验收" }), before = expect(await t.h.request(`/api/v1/agent-tasks/${task.id}`, { cookie: t.alice.cookie })).task;
    browser = await chromium.launch({ executablePath, headless: true }); page = await browser.newPage({ viewport: { width: 1100, height: 900 } }); page.setDefaultTimeout(10000);
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    const region = await open(page, t), filter = region.getByRole("combobox", { name: "线程状态筛选", exact: true });
    await region.getByRole("button", { name: task.subject, exact: true }).click(); const detail = region.getByRole("article", { name: "Agent 线程详情", exact: true });
    page.once("dialog", dialog => dialog.dismiss()); await detail.getByRole("button", { name: "标记人工完成", exact: true }).click();
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_thread_operations").first("n"), 0);
    page.on("dialog", dialog => { assert.match(dialog.message(), /不取消或重试派发/); return dialog.accept(); });
    await detail.getByRole("button", { name: "标记人工完成", exact: true }).click(); await detail.getByRole("status").filter({ hasText: "人工已完成" }).waitFor();
    await filter.selectOption("open"); await region.getByText("暂无 Agent 线程", { exact: true }).waitFor();
    await filter.selectOption("completed"); await region.getByRole("button", { name: task.subject, exact: true }).click();
    await detail.getByRole("button", { name: "归档线程", exact: true }).click(); await detail.getByRole("status").filter({ hasText: "已归档" }).waitFor();
    await filter.selectOption("archived"); await region.getByRole("button", { name: task.subject, exact: true }).click();
    await detail.getByRole("button", { name: "恢复处理中", exact: true }).click(); await detail.getByRole("status").filter({ hasText: "处理中" }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(t.h.directory, "agent-threads-mobile.png"), fullPage: true });
    await page.getByRole("combobox", { name: "权限", exact: true }).selectOption("agent-threads"); await page.getByLabel("名称", { exact: true }).fill("thread metadata");
    await page.getByRole("button", { name: "创建 Key", exact: true }).click(); const token = await page.getByTestId("new-key").textContent();
    const scopes = JSON.parse(await t.h.db.prepare("SELECT scopes FROM api_keys WHERE name='thread metadata'").first("scopes"));
    assert.deepEqual(scopes, ["agent-tasks:read", "agent-threads:write"]); expect(await t.threads("", { token }));
    expect(await t.h.request("/api/v1/agent-tasks", { method: "POST", token, body: {} }), 403);
    assert.deepEqual(expect(await t.h.request(`/api/v1/agent-tasks/${task.id}`, { cookie: t.alice.cookie })).task, before);
    assert.equal(t.opens.length, 0); assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0); assert.deepEqual(errors, []);
  } catch (error) { if (page) console.error(await page.locator("body").ariaSnapshot()); throw error; }
  finally { await browser?.close(); await t.close(); }
});

test("Chrome: unknown thread writes retain one body/key through navigation, reconcile before retry and never relock confirmed refresh failure", { timeout: 90000 }, async () => {
  const t = await agentThreadsFixture({ browser: true }); let browser, page, releaseContext;
  try {
    const task = await t.task({ submitted: false, subject: "未知线程操作" }); await t.task({ subject: "其他线程" });
    browser = await chromium.launch({ executablePath, headless: true }); page = await browser.newPage(); page.setDefaultTimeout(10000); page.on("dialog", dialog => dialog.accept());
    const region = await open(page, t); await region.getByRole("button", { name: task.subject, exact: true }).click();
    const detail = region.getByRole("article", { name: "Agent 线程详情", exact: true });
    await detail.getByRole("button", { name: "标记人工完成", exact: true }).click(); await region.getByText("线程状态已保存", { exact: true }).waitFor();
    const keys = [], bodies = []; let reads = 0, valid = false, failRefresh = false, holdContext = false, enterContext;
    const contextEntered = new Promise(resolve => { enterContext = resolve; });
    await page.route(`**/api/v1/agent-threads/${task.id}/followup-context`, async route => {
      if (holdContext) { holdContext = false; enterContext(); await new Promise(resolve => { releaseContext = resolve; }); }
      return route.continue();
    });
    await page.route(`**/api/v1/agent-threads/${task.id}/state`, async route => {
      keys.push(route.request().headers()["idempotency-key"]); bodies.push(route.request().postData());
      if (keys.length === 1) return route.abort("failed"); await route.fetch(); return route.fulfill({ status: 200, json: {} });
    });
    await page.route("**/api/v1/agent-thread-operations/*", route => { reads++; return valid || reads === 1 ? route.continue() : route.fulfill({ status: 200, json: {} }); });
    await page.route("**/api/v1/agent-threads", route => failRefresh ? route.fulfill({ status: 503, json: { error: { code: "synthetic_thread_refresh_failed" } } }) : route.continue());
    await detail.getByRole("button", { name: "归档线程", exact: true }).click(); const recover = region.getByRole("button", { name: "核对原线程操作", exact: true }); await recover.waitFor();
    assert.equal(await region.getByText("线程状态已保存", { exact: true }).count(), 0);
    assert.equal(await region.getByRole("combobox", { name: "线程状态筛选", exact: true }).isDisabled(), true);
    assert.equal(await region.getByRole("button", { name: "其他线程", exact: true }).isDisabled(), true);
    await page.getByRole("navigation").getByRole("button", { name: "Agent 服务", exact: true }).click();
    await page.getByRole("navigation").getByRole("button", { name: "Agent 线程", exact: true }).click();
    await recover.click(); await region.getByRole("alert").filter({ hasText: "线程响应不匹配" }).waitFor(); await recover.click();
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some(row => row.textContent === "核对原线程操作" && !row.disabled));
    assert.equal(keys.length, 2); assert.equal(new Set(keys).size, 1); assert.equal(new Set(bodies).size, 1);
    valid = true; failRefresh = true; holdContext = true; await recover.click(); await region.getByRole("alert").filter({ hasText: "synthetic_thread_refresh_failed" }).waitFor();
    await contextEntered; assert.equal(await recover.count(), 0);
    const filter = region.getByRole("combobox", { name: "线程状态筛选", exact: true }); assert.equal(await filter.isDisabled(), true);
    releaseContext(); releaseContext = null;
    await page.waitForFunction(() => document.querySelector('section[aria-label="Agent 线程"] select')?.disabled === false);
    assert.equal(await filter.isEnabled(), true);
    assert.equal(keys.length, 2); assert.equal(expect(await t.thread(task.id)).thread.management.revision, 2);
    failRefresh = false; await region.getByRole("button", { name: "刷新 Agent 线程", exact: true }).click();
    await detail.getByRole("status").filter({ hasText: "已归档" }).waitFor();
    const bob = await t.h.register("thread-browser-bob"); await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await page.getByLabel("用户名", { exact: true }).fill(bob.username); await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByRole("navigation").getByRole("button", { name: "Agent 线程", exact: true }).click(); await region.getByText("暂无 Agent 线程", { exact: true }).waitFor();
    assert.equal(await detail.count(), 0); assert.equal(t.opens.length, 0);
  } catch (error) { if (page) console.error(await page.locator("body").ariaSnapshot()); throw error; }
  finally { releaseContext?.(); await browser?.close(); await t.close(); }
});

test("Chrome: thread pagination preserves state filter and abandon requires confirmation without undoing a committed operation", { timeout: 90000 }, async () => {
  const t = await agentThreadsFixture({ browser: true }); let browser;
  try {
    for (let i = 0; i < 21; i++) await t.task({ subject: `分页线程-${i}` });
    const ids = (await t.h.db.prepare("SELECT id FROM agent_threads ORDER BY id").all()).results.map(row => row.id), last = ids.at(-1);
    browser = await chromium.launch({ executablePath, headless: true }); const page = await browser.newPage(); page.setDefaultTimeout(10000);
    const region = await open(page, t); await region.getByRole("button", { name: "加载更多 Agent 线程", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('section[aria-label="Agent 线程"] > ul')?.children.length === 21);
    assert.equal(await region.locator(":scope > ul > li").count(), 21);
    const subject = await t.h.db.prepare("SELECT subject FROM agent_outgoing_messages WHERE thread_id=?").bind(last).first("subject");
    await region.getByRole("button", { name: subject, exact: true }).click();
    await page.route(`**/api/v1/agent-threads/${last}/state`, async route => { await route.fetch(); return route.abort("failed"); });
    page.once("dialog", dialog => dialog.accept()); await region.getByRole("button", { name: "归档线程", exact: true }).click();
    const recover = region.getByRole("button", { name: "核对原线程操作", exact: true }); await recover.waitFor();
    page.once("dialog", dialog => dialog.dismiss()); await region.getByRole("button", { name: "放弃本页线程核对", exact: true }).click(); await recover.waitFor();
    page.once("dialog", dialog => dialog.accept()); await region.getByRole("button", { name: "放弃本页线程核对", exact: true }).click();
    await recover.waitFor({ state: "detached" }); await region.getByRole("button", { name: "刷新 Agent 线程", exact: true }).click();
    await region.getByRole("combobox", { name: "线程状态筛选", exact: true }).selectOption("archived"); await region.getByRole("button", { name: subject, exact: true }).click();
    await region.getByRole("article", { name: "Agent 线程详情", exact: true }).getByRole("status").filter({ hasText: "已归档" }).waitFor();
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_thread_operations").first("n"), 1); assert.equal(t.opens.length, 0);
  } finally { await browser?.close(); await t.close(); }
});
