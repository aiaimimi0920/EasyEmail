import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { PASSWORD } from "./runtime-harness.mjs";
import { agentTasksFixture } from "./agent-tasks-fixture.mjs";

const executablePath = process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
async function open(page, t) {
  await page.goto(t.h.baseUrl.href); await page.getByLabel("用户名", { exact: true }).fill(t.alice.username);
  await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("navigation").getByRole("button", { name: "Agent 任务", exact: true }).click();
  const region = page.getByRole("region", { name: "Agent 任务", exact: true });
  await region.getByRole("combobox", { name: "任务远程服务", exact: true }).selectOption(t.serviceId);
  await region.getByRole("combobox", { name: "任务发件邮箱", exact: true }).selectOption(t.accountId);
  await region.getByLabel("任务主题", { exact: true }).fill(t.input.subject); await region.getByLabel("任务正文", { exact: true }).fill(t.input.text);
  await page.waitForFunction(() => ![...document.querySelectorAll("button")].find(row => row.textContent === "创建并排队发送 Agent 任务")?.disabled);
  return region;
}
async function submit(page, region) {
  page.once("dialog", dialog => dialog.accept()); await region.getByRole("button", { name: "创建并排队发送 Agent 任务", exact: true }).click();
}

test("Chrome: Agent task real protocol submission, explicit confirmation, cancellation, Key and mobile workflow", { timeout: 90000 }, async () => {
  const t = await agentTasksFixture(true); let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true }); const page = await browser.newPage({ viewport: { width: 1100, height: 900 } }); page.setDefaultTimeout(10000);
    const errors = [], external = []; page.on("pageerror", e => errors.push(e.message)); page.on("request", r => { if (!r.url().startsWith(t.h.baseUrl.origin)) external.push(r.url()); });
    const region = await open(page, t);
    page.once("dialog", dialog => dialog.dismiss()); await region.getByRole("button", { name: "创建并排队发送 Agent 任务", exact: true }).click();
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_threads").first("n"), 0);
    await submit(page, region); const detail = region.getByRole("article", { name: "Agent 任务详情", exact: true });
    await detail.getByRole("status").filter({ hasText: "等待派发" }).waitFor(); assert.equal(t.opens.length, 0);
    page.once("dialog", dialog => dialog.accept()); await detail.getByRole("button", { name: "取消 Agent 任务派发", exact: true }).click();
    await detail.getByRole("status").filter({ hasText: "已取消派发" }).waitFor(); await t.run(); assert.equal(t.opens.length, 0);
    page.once("dialog", dialog => dialog.accept()); await region.getByRole("button", { name: "另建 Agent 任务", exact: true }).click();
    await region.getByLabel("任务主题", { exact: true }).fill("新任务"); await region.getByLabel("任务正文", { exact: true }).fill("真实本地协议验收");
    await submit(page, region); await detail.getByRole("status").filter({ hasText: "等待派发" }).waitFor(); await t.run();
    await detail.getByRole("button", { name: "刷新 Agent 任务状态", exact: true }).click();
    await detail.getByRole("status").filter({ hasText: "SMTP 已接受，送达未确认" }).waitFor(); assert.equal(t.messages.length, 1);
    assert.equal(await detail.getByRole("button", { name: "取消 Agent 任务派发", exact: true }).count(), 0);
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(t.h.directory, "agent-tasks-mobile.png"), fullPage: true });
    await page.getByRole("combobox", { name: "权限", exact: true }).selectOption("agent-tasks");
    await page.getByLabel("名称", { exact: true }).fill("Task API"); await page.getByRole("button", { name: "创建 Key", exact: true }).click();
    const token = await page.getByTestId("new-key").textContent(), response = await t.h.request("/api/v1/agent-tasks", { token }); assert.equal(response.status, 200);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0); assert.deepEqual(errors, []); assert.deepEqual(external, []);
  } finally { await browser?.close(); await t.close(); }
});

test("Chrome: Agent task unknown and malformed receipts preserve one immutable body/key across tabs and 404 reconciliation", { timeout: 90000 }, async () => {
  const t = await agentTasksFixture(true); let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true }); const page = await browser.newPage(); page.setDefaultTimeout(10000);
    const region = await open(page, t), keys = [], bodies = []; let valid = false, reads = 0;
    await page.route("**/api/v1/agent-tasks", async route => {
      if (route.request().method() !== "POST") return route.continue(); keys.push(route.request().headers()["idempotency-key"]); bodies.push(route.request().postData());
      if (keys.length === 1) return route.abort("failed"); await route.fetch(); return route.fulfill({ status: 201, json: {} });
    });
    await page.route("**/api/v1/agent-tasks?requestKey=*", route => { reads++; return valid ? route.continue() : reads === 1 ? route.continue() : route.fulfill({ status: 200, json: {} }); });
    await submit(page, region); const recover = region.getByRole("button", { name: "核对原 Agent 任务", exact: true }); await recover.waitFor();
    await page.getByRole("navigation").getByRole("button", { name: "Agent 服务", exact: true }).click();
    await page.getByRole("navigation").getByRole("button", { name: "Agent 任务", exact: true }).click();
    await recover.click(); await region.getByRole("alert").filter({ hasText: "响应不匹配" }).waitFor();
    await recover.click(); await region.getByRole("alert").filter({ hasText: "响应不匹配" }).waitFor();
    assert.equal(keys.length, 2); assert.equal(new Set(keys).size, 1); assert.equal(new Set(bodies).size, 1);
    assert.equal(await region.getByLabel("任务主题", { exact: true }).isDisabled(), true);
    valid = true; await recover.click(); await region.getByRole("article", { name: "Agent 任务详情", exact: true }).getByRole("status").filter({ hasText: "等待派发" }).waitFor();
    assert.equal(keys.length, 2); assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_threads").first("n"), 1);
    const bob = await t.h.register("agent-task-web-bob"); await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await page.getByLabel("用户名", { exact: true }).fill(bob.username); await page.getByLabel("密码", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "登录", exact: true }).click(); await page.getByRole("navigation").getByRole("button", { name: "Agent 任务", exact: true }).click();
    assert.equal(await region.getByRole("article", { name: "Agent 任务详情", exact: true }).count(), 0); assert.equal(await region.getByLabel("任务正文", { exact: true }).inputValue(), "");
  } finally { await browser?.close(); await t.close(); }
});

test("Chrome: Agent task sources load 101 services using the real opaque cursor without losing accounts", { timeout: 90000 }, async () => {
  const t = await agentTasksFixture(true); let browser;
  try {
    const last = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await t.h.db.batch(Array.from({ length: 100 }, (_, n) => t.h.db.prepare(`INSERT INTO agent_services
      (user_id,id,display_name,email_address,service_kind,trust_level,status,version,created_at,updated_at)
      VALUES (?,?,?,?,'email','trusted','active',1,unixepoch(),unixepoch())`).bind(t.alice.id,
      n === 99 ? last : `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, `分页任务服务 ${n}`, `page-${n}@example.test`)));
    browser = await chromium.launch({ executablePath, headless: true }); const page = await browser.newPage(); page.setDefaultTimeout(10000);
    const region = await open(page, t), services = region.getByRole("combobox", { name: "任务远程服务", exact: true });
    assert.equal(await services.getByRole("option").count(), 101);
    assert.equal(await region.getByRole("combobox", { name: "任务发件邮箱", exact: true }).inputValue(), t.accountId);
    await region.getByRole("button", { name: "加载更多任务服务", exact: true }).click();
    await services.selectOption(last); assert.equal(await services.getByRole("option").count(), 102);
    assert.equal(await region.getByRole("button", { name: "加载更多任务服务", exact: true }).count(), 0);
    await submit(page, region); await region.getByRole("article", { name: "Agent 任务详情", exact: true }).waitFor();
    assert.equal(await t.h.db.prepare("SELECT service_id FROM agent_threads").first("service_id"), last);
    assert.equal(t.opens.length, 0);
  } finally { await browser?.close(); await t.close(); }
});

test("Chrome: refreshing sources rechecks SMTP independently, ignores its late old response and reconciles unknown cancellation", { timeout: 90000 }, async () => {
  const t = await agentTasksFixture(true); let browser, release;
  try {
    browser = await chromium.launch({ executablePath, headless: true }); const page = await browser.newPage(); page.setDefaultTimeout(10000);
    const region = await open(page, t), create = region.getByRole("button", { name: "创建并排队发送 Agent 任务", exact: true });
    let entered; const waiting = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; }); let reads = 0;
    await page.route(`**/api/v1/agent-accounts/${t.accountId}/smtp`, async route => {
      if (++reads !== 1) return route.continue(); const response = await route.fetch(); entered(); await waiting; await route.fulfill({ response });
    });
    const refresh = region.getByRole("button", { name: "刷新任务来源", exact: true });
    await refresh.click(); await started;
    await t.h.db.prepare("UPDATE agent_smtp_configs SET enabled=0,revision=2 WHERE account_id=?").bind(t.accountId).run();
    const disabledRead = page.waitForResponse(r => r.url().endsWith(`/agent-accounts/${t.accountId}/smtp`) && r.status() === 200);
    await refresh.click(); await disabledRead;
    const oldResponse = page.waitForResponse(r => r.url().endsWith(`/agent-accounts/${t.accountId}/smtp`) && r.status() === 200);
    release(); await oldResponse; await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await create.isDisabled(), true);
    await t.h.db.prepare("UPDATE agent_smtp_configs SET enabled=1,revision=3 WHERE account_id=?").bind(t.accountId).run();
    await refresh.click(); await page.waitForFunction(() => ![...document.querySelectorAll("button")].find(row => row.textContent === "创建并排队发送 Agent 任务")?.disabled);
    await submit(page, region); const detail = region.getByRole("article", { name: "Agent 任务详情", exact: true }); await detail.waitFor();
    assert.equal(await t.h.db.prepare("SELECT smtp_revision FROM agent_threads").first("smtp_revision"), 3);
    await page.route("**/api/v1/agent-tasks/*/cancel", async route => { await route.fetch(); await route.fulfill({ status: 200, json: {} }); });
    page.once("dialog", dialog => dialog.accept()); await detail.getByRole("button", { name: "取消 Agent 任务派发", exact: true }).click();
    await region.getByRole("alert").filter({ hasText: "响应不匹配" }).waitFor();
    assert.equal(await detail.getByRole("status").textContent(), "等待派发");
    await detail.getByRole("button", { name: "刷新 Agent 任务状态", exact: true }).click(); await detail.getByRole("status").filter({ hasText: "已取消派发" }).waitFor();
    await t.run(); assert.equal(t.opens.length, 0);
  } finally { release?.(); await browser?.close(); await t.close(); }
});
