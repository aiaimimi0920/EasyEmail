import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { PASSWORD } from "./runtime-harness.mjs";
import { agentReviewFixture } from "./agent-review-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";

const executablePath = process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
async function open(page, t) {
  await page.goto(t.h.baseUrl.href); await page.getByLabel("用户名", { exact: true }).fill(t.alice.username);
  await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("navigation").getByRole("button", { name: "Agent 邮箱", exact: true }).click();
  const accounts = page.getByRole("region", { name: "Agent 邮箱", exact: true }); await accounts.getByRole("button", { name: "普通邮箱", exact: true }).click();
  return accounts.getByRole("region", { name: "Agent 收件", exact: true });
}
const reviewDetail = region => region.getByRole("article", { name: "Agent 邮件详情", exact: true });

test("Chrome: attention queue, explicit manual linking, relinking and dismissal leave dispatch and original headers untouched", { timeout: 90000 }, async () => {
  const t = await agentReviewFixture({ browser: true }); let browser, page;
  try {
    const second = await t.task({ subject: "第二个人工目标" }), before = (await t.h.db.prepare("SELECT * FROM agent_outgoing_messages ORDER BY id").all()).results;
    browser = await chromium.launch({ executablePath, headless: true }); page = await browser.newPage({ viewport: { width: 1100, height: 900 } }); page.setDefaultTimeout(10000);
    const errors = []; page.on("pageerror", e => errors.push(e.message)); page.on("dialog", dialog => dialog.accept());
    const region = await open(page, t), filter = region.getByRole("combobox", { name: "Agent 处理筛选", exact: true });
    await filter.selectOption("attention"); await region.getByRole("button", { name: "任务回复", exact: true }).click();
    const detail = reviewDetail(region); await detail.getByRole("combobox", { name: "人工关联任务", exact: true }).selectOption(t.firstTask.id);
    await detail.getByRole("button", { name: "关联所选任务", exact: true }).click(); await region.getByText("暂无 Agent 邮件", { exact: true }).waitFor();
    await filter.selectOption("handled"); await region.getByRole("button", { name: "任务回复", exact: true }).click(); await detail.getByText("人工已关联 · 发件身份未验证", { exact: true }).waitFor();
    await detail.getByRole("combobox", { name: "人工关联任务", exact: true }).selectOption(second.id); await detail.getByRole("button", { name: "关联所选任务", exact: true }).click();
    await region.getByRole("button", { name: "任务回复", exact: true }).click(); await detail.getByText(`有效任务 ID：${second.id}`, { exact: true }).waitFor();
    await page.getByRole("navigation").getByRole("button", { name: "Agent 任务", exact: true }).click();
    const tasks = page.getByRole("region", { name: "Agent 任务", exact: true }); await tasks.getByRole("button", { name: "第二个人工目标", exact: true }).click();
    const replies = tasks.getByRole("region", { name: "任务关联回信", exact: true }); await replies.getByRole("button", { name: "任务回复", exact: true }).click();
    await replies.getByText("人工已关联 · 发件身份未验证", { exact: true }).waitFor();
    await page.getByRole("navigation").getByRole("button", { name: "Agent 邮箱", exact: true }).click(); await region.getByRole("button", { name: "任务回复", exact: true }).click();
    await detail.getByRole("button", { name: "忽略此邮件", exact: true }).click(); await region.getByRole("button", { name: "任务回复", exact: true }).click();
    await detail.getByText("已忽略 · 发件身份未验证", { exact: true }).waitFor(); await detail.getByRole("button", { name: "重新关注", exact: true }).click();
    await region.getByText("暂无 Agent 邮件", { exact: true }).waitFor(); await filter.selectOption("attention"); await region.getByRole("button", { name: "任务回复", exact: true }).click();
    await page.getByRole("combobox", { name: "权限", exact: true }).selectOption("agent-inbox-review"); await page.getByLabel("名称", { exact: true }).fill("manual classification");
    await page.getByRole("button", { name: "创建 Key", exact: true }).click(); const token = await page.getByTestId("new-key").textContent();
    expect(await t.targets("", { token })); expect(await t.h.request("/api/v1/agent-tasks", { method: "POST", token, body: {} }), 403);
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(t.h.directory, "agent-review-mobile.png"), fullPage: true });
    const current = expect(await t.message(t.incoming.id)).message; assert.equal(current.association, "unmatched"); assert.equal(current.threadId, null); assert.equal(current.review.revision, 4);
    assert.deepEqual((await t.h.db.prepare("SELECT * FROM agent_outgoing_messages ORDER BY id").all()).results, before); assert.equal(t.opens.length, 1);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0); assert.deepEqual(errors, []);
  } catch (error) { if (page) console.error(await page.locator("body").ariaSnapshot()); throw error; }
  finally { await browser?.close(); await t.close(); }
});

test("Chrome: target pagination preserves explicit selection and cancelled confirmation performs no write", { timeout: 90000 }, async () => {
  const t = await agentReviewFixture({ browser: true }); let browser;
  try {
    for (let i = 0; i < 20; i++) await t.task({ subject: `人工分页目标-${i}` });
    const ids = (await t.h.db.prepare("SELECT id FROM agent_threads ORDER BY id").all()).results.map(row => row.id), finalId = ids.at(-1);
    browser = await chromium.launch({ executablePath, headless: true }); const page = await browser.newPage(); page.setDefaultTimeout(10000);
    const region = await open(page, t); await region.getByRole("button", { name: "任务回复", exact: true }).click();
    const detail = reviewDetail(region), picker = detail.getByRole("combobox", { name: "人工关联任务", exact: true });
    await detail.getByRole("button", { name: "加载更多关联任务", exact: true }).waitFor(); assert.equal(await picker.inputValue(), "");
    assert.equal(await picker.locator(`option[value="${finalId}"]`).count(), 0); await detail.getByRole("button", { name: "加载更多关联任务", exact: true }).click();
    await picker.selectOption(finalId); page.once("dialog", dialog => dialog.dismiss()); await detail.getByRole("button", { name: "关联所选任务", exact: true }).click();
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_review_operations").first("n"), 0);
    page.once("dialog", dialog => dialog.accept()); await detail.getByRole("button", { name: "关联所选任务", exact: true }).click();
    await region.getByRole("status").filter({ hasText: "人工处理已保存" }).waitFor(); assert.equal(expect(await t.message(t.incoming.id)).message.review.threadId, finalId);
    assert.equal(t.opens.length, 1);
  } finally { await browser?.close(); await t.close(); }
});

test("Chrome: uncertain review retains original body/key across tabs and reconciles before retry; refresh failure cannot relock confirmed success", { timeout: 90000 }, async () => {
  const t = await agentReviewFixture({ browser: true }); let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true }); const page = await browser.newPage(); page.setDefaultTimeout(10000);
    const region = await open(page, t), keys = [], bodies = []; let valid = false, reads = 0, failRefresh = false;
    await region.getByRole("button", { name: "任务回复", exact: true }).click(); await reviewDetail(region).getByRole("button", { name: "重新关注", exact: true }).click();
    await region.getByRole("status").filter({ hasText: "人工处理已保存" }).waitFor(); await region.getByRole("button", { name: "刷新 Agent 缓存", exact: true }).click();
    await page.route(`**${t.base}/messages/${t.incoming.id}/review`, async route => {
      keys.push(route.request().headers()["idempotency-key"]); bodies.push(route.request().postData());
      if (keys.length === 1) return route.abort("failed"); await route.fetch(); return route.fulfill({ status: 200, json: {} });
    });
    await page.route(`**${t.base}/review-operations/*`, route => { reads++; return valid || reads === 1 ? route.continue() : route.fulfill({ status: 200, json: {} }); });
    await page.route(`**${t.base}/messages?*`, route => failRefresh ? route.fulfill({ status: 503, json: { error: { code: "synthetic_refresh_failed" } } }) : route.continue());
    await region.getByRole("button", { name: "任务回复", exact: true }).click(); await reviewDetail(region).getByRole("button", { name: "忽略此邮件", exact: true }).click();
    const recover = region.getByRole("button", { name: "核对原人工处理", exact: true }); await recover.waitFor();
    assert.equal(await region.getByRole("status").filter({ hasText: "人工处理已保存" }).count(), 0, "an old success must not masquerade as the current uncertain write");
    assert.equal(await region.getByRole("combobox", { name: "Agent 处理筛选", exact: true }).isDisabled(), true); assert.equal(await region.getByRole("button", { name: "任务回复", exact: true }).isDisabled(), true);
    const accounts = page.getByRole("region", { name: "Agent 邮箱", exact: true }); await page.waitForFunction(() => [...document.querySelectorAll("button")].some(row => row.textContent === "移除 Agent 邮箱" && row.disabled));
    assert.equal(await accounts.getByRole("button", { name: "移除 Agent 邮箱", exact: true }).isDisabled(), true);
    await page.getByRole("navigation").getByRole("button", { name: "Agent 服务", exact: true }).click(); await page.getByRole("navigation").getByRole("button", { name: "Agent 邮箱", exact: true }).click();
    await recover.click(); await region.getByRole("alert").filter({ hasText: "人工处理响应不匹配" }).waitFor(); await recover.click();
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some(row => row.textContent === "核对原人工处理" && !row.disabled));
    assert.equal(keys.length, 2); assert.equal(new Set(keys).size, 1); assert.equal(new Set(bodies).size, 1);
    valid = true; failRefresh = true; await recover.click(); await region.getByRole("alert").filter({ hasText: "synthetic_refresh_failed" }).waitFor();
    assert.equal(await recover.count(), 0); assert.equal(await region.getByRole("combobox", { name: "Agent 处理筛选", exact: true }).isEnabled(), true);
    assert.equal(keys.length, 2); assert.equal(expect(await t.message(t.incoming.id)).message.review.revision, 2);
    failRefresh = false; await region.getByRole("button", { name: "刷新 Agent 缓存", exact: true }).click();
    const bob = await t.h.register("review-browser-bob"); await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await page.getByLabel("用户名", { exact: true }).fill(bob.username); await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByRole("navigation").getByRole("button", { name: "Agent 邮箱", exact: true }).click(); await accounts.getByText("暂无 Agent 邮箱", { exact: true }).waitFor();
    assert.equal(await region.count(), 0); assert.equal(t.opens.length, 1);
  } finally { await browser?.close(); await t.close(); }
});
