import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { PASSWORD } from "./runtime-harness.mjs";
import { agentTasksFixture } from "./agent-tasks-fixture.mjs";
import { getService, serviceWrite, expect } from "./agent-services-fixture.mjs";
import { agentWrite, agentAccountInput } from "./agent-accounts-fixture.mjs";
import { SMTP_PASSWORD } from "./normal-send-fixture.mjs";

const field = (page, name) => page.getByLabel(name, { exact: true });
const select = (page, name) => page.getByRole("combobox", { name, exact: true });
const button = (page, name) => page.getByRole("button", { name, exact: true });
const chrome = () => chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
async function login(page, h, user, tab = "Agent 任务") {
  try {
    await page.goto(h.baseUrl.href); await field(page, "用户名").fill(user.username); await field(page, "密码").fill(PASSWORD);
    await button(page, "登录").click(); await page.getByRole("navigation").getByRole("button", { name: tab, exact: true }).click();
  } catch (error) {
    console.error(error); console.error(await page.locator("body").ariaSnapshot({ timeout: 2000 }).catch(failure => failure.message));
    await page.screenshot({ path: path.join(h.directory, "agent-senders-login-failure.png"), fullPage: true, timeout: 2000 }).catch(() => {}); throw error;
  }
}

test("Chrome: definitive task success survives a failed list reload without a ghost recovery lock", { timeout: 90000 }, async () => {
  const t = await agentTasksFixture(true); let browser, page;
  try {
    browser = await chrome(); page = await browser.newPage(); page.setDefaultTimeout(10000); await login(page, t.h, t.alice);
    let fail = false, failure = "http", posts = 0;
    await page.route("**/api/v1/agent-tasks", async route => {
      if (route.request().method() === "POST") { const response = await route.fetch(); posts++; fail = true; return route.fulfill({ response }); }
      if (fail) { fail = false; return route.fulfill({ status: failure === "http" ? 500 : 200, contentType: "application/json", body: "{}" }); }
      return route.continue();
    });
    for (const mode of ["http", "malformed"]) {
      failure = mode;
      if (mode !== "http") { page.once("dialog", dialog => dialog.accept()); await button(page, "另建 Agent 任务").click(); }
      await select(page, "任务远程服务").selectOption(t.serviceId); await select(page, "任务发件邮箱").selectOption(t.accountId);
      await field(page, "任务主题").fill(`accepted-reload-${mode}`); await field(page, "任务正文").fill("synthetic reload regression");
      page.once("dialog", dialog => dialog.accept()); await button(page, "创建并排队发送 Agent 任务").click();
      await page.getByRole("alert").waitFor();
      assert.equal(await button(page, "核对原 Agent 任务").count(), 0, "A failed list reload cannot turn confirmed success into an unrecoverable unknown attempt");
      assert.equal(await button(page, "刷新 Agent 任务状态").isDisabled(), false);
      await button(page, "刷新 Agent 任务列表").click(); await button(page, `accepted-reload-${mode}`).waitFor();
    }
    assert.equal(posts, 2); assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_threads").first("n"), 2);
    assert.equal(t.opens.length, 0);
  } finally { await browser?.close(); await t.close(); }
});

test("Chrome: configure, explicitly use, send and clear a private service default with mobile and user isolation", { timeout: 120000 }, async () => {
  const t = await agentTasksFixture(true); let browser, page;
  try {
    browser = await chrome(); page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); page.setDefaultTimeout(10000);
    const errors = [], external = [], posts = []; page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (!request.url().startsWith(t.h.baseUrl.origin)) external.push(request.url()); });
    await login(page, t.h, t.alice, "Agent 服务"); await button(page, "编辑服务 远程任务服务").click();
    await button(page, "加载 Agent 发件邮箱").click(); await select(page, "服务默认发件邮箱").selectOption(t.accountId);
    page.once("dialog", dialog => dialog.accept()); await button(page, "保存服务修改").click();
    await page.waitForFunction(() => [...document.querySelectorAll("small")].some(row => row.textContent?.includes("版本 2")));
    assert.equal(expect(await getService(t.h, t.alice, t.serviceId)).service.defaultSenderAccountId, t.accountId);
    await page.getByRole("navigation").getByRole("button", { name: "Agent 任务", exact: true }).click();
    await select(page, "任务远程服务").selectOption(t.serviceId); assert.equal(await select(page, "任务发件邮箱").inputValue(), "");
    await button(page, "使用服务默认邮箱").click();
    await page.waitForFunction(id => document.querySelector('select[required]') && [...document.querySelectorAll("select")].some(row => row.value === id), t.accountId);
    assert.equal(await select(page, "任务发件邮箱").inputValue(), t.accountId);
    await field(page, "任务主题").fill("explicit default task"); await field(page, "任务正文").fill("local protocol acceptance");
    await page.route("**/api/v1/agent-tasks", route => {
      if (route.request().method() === "POST") posts.push(route.request().postDataJSON()); return route.continue();
    });
    page.once("dialog", dialog => dialog.accept()); await button(page, "创建并排队发送 Agent 任务").click();
    const detail = page.getByRole("article", { name: "Agent 任务详情", exact: true }); await detail.getByRole("status").filter({ hasText: "等待派发" }).waitFor();
    assert.equal(posts.length, 1); assert.equal(posts[0].senderAccountId, t.accountId); assert.equal(posts[0].accountRevision, 1); assert.equal(posts[0].smtpRevision, 1);
    assert.equal(Object.hasOwn(posts[0], "defaultSenderAccountId"), false); assert.equal(t.opens.length, 0);
    await t.run(); await button(page, "刷新 Agent 任务状态").click(); await detail.getByRole("status").filter({ hasText: "SMTP 已接受，送达未确认" }).waitFor();
    assert.equal(t.messages.length, 1); assert.match(t.messages[0], /From: <sender@example\.test>/);
    await page.getByRole("navigation").getByRole("button", { name: "Agent 服务", exact: true }).click(); await button(page, "编辑服务 远程任务服务").click();
    assert.equal(await select(page, "服务默认发件邮箱").inputValue(), t.accountId); await select(page, "服务默认发件邮箱").selectOption("");
    page.once("dialog", dialog => dialog.accept()); await button(page, "保存服务修改").click();
    await page.waitForFunction(() => [...document.querySelectorAll("small")].some(row => row.textContent?.includes("版本 3")));
    assert.equal(expect(await getService(t.h, t.alice, t.serviceId)).service.defaultSenderAccountId, null);
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(t.h.directory, "agent-senders-mobile.png"), fullPage: true });
    const bob = await t.h.register("default-web-bob"); await button(page, "退出登录").click(); await login(page, t.h, bob, "Agent 服务");
    await button(page, "加载 Agent 发件邮箱").click(); assert.equal(await select(page, "服务默认发件邮箱").inputValue(), "");
    assert.equal(await select(page, "服务默认发件邮箱").locator("option").count(), 1);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0); assert.deepEqual(errors, []); assert.deepEqual(external, []);
  } finally { await browser?.close(); await t.close(); }
});

test("Chrome: a default outside the first 100 accounts is fetched exactly; invalid or missing defaults never fall back", { timeout: 120000 }, async () => {
  const t = await agentTasksFixture(true); let browser, page;
  try {
    const target = "ffffffff-ffff-4fff-8fff-fffffffffff0";
    expect(await agentWrite(t.h, t.alice, target, { ...agentAccountInput, emailAddress: "last-default@example.test", username: "Alice" }), 201);
    expect(await t.h.request(`/api/v1/agent-accounts/${target}/smtp`, { method: "PUT", cookie: t.alice.cookie, headers: { "idempotency-key": crypto.randomUUID() },
      body: { expectedRevision: 1, smtpRevision: 0, endpointId: "example", username: "Alice", password: SMTP_PASSWORD, enabled: true } }));
    await t.h.db.batch(Array.from({ length: 100 }, (_, n) => t.h.db.prepare(`INSERT INTO agent_accounts
      (id,user_id,email_address,display_name,endpoint_id,endpoint_hash,username,enabled,revision,created_at,updated_at)
      VALUES(?,?,?,?,'example','hash','dummy',0,1,unixepoch(),unixepoch())`)
      .bind(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, t.alice.id, `dummy-${n}@example.test`, `dummy ${n}`)));
    expect(await serviceWrite(t.h, t.alice, "PATCH", t.serviceId, { expectedVersion: 1, defaultSenderAccountId: target }));
    browser = await chrome(); page = await browser.newPage(); page.setDefaultTimeout(10000); await login(page, t.h, t.alice);
    await select(page, "任务远程服务").selectOption(t.serviceId);
    assert.equal(await select(page, "任务发件邮箱").locator(`option[value="${target}"]`).count(), 0);
    await button(page, "使用服务默认邮箱").click(); await select(page, "任务发件邮箱").locator(`option[value="${target}"]`).waitFor({ state: "attached" });
    assert.equal(await select(page, "任务发件邮箱").inputValue(), target);
    const account = expect(await t.h.request(`/api/v1/agent-accounts/${target}`, { cookie: t.alice.cookie })).account;
    await page.route(`**/api/v1/agent-accounts/${target}`, route => route.fulfill({ status: 200, json: { account: { ...account, id: t.accountId } } }));
    await button(page, "使用服务默认邮箱").click(); await page.getByRole("alert").filter({ hasText: "未选择发件邮箱" }).waitFor();
    assert.equal(await select(page, "任务发件邮箱").inputValue(), ""); assert.equal(await button(page, "创建并排队发送 Agent 任务").isDisabled(), true);
    await page.unroute(`**/api/v1/agent-accounts/${target}`);
    await page.route(`**/api/v1/agent-accounts/${target}`, route => route.fulfill({ status: 200, json: { account: { ...account, enabled: false } } }));
    await button(page, "使用服务默认邮箱").click();
    await page.waitForFunction(id => [...document.querySelectorAll("select")].some(row => row.value === id), target);
    assert.equal(await select(page, "任务发件邮箱").inputValue(), target); assert.equal(await button(page, "创建并排队发送 Agent 任务").isDisabled(), true);
    await page.unroute(`**/api/v1/agent-accounts/${target}`);
    expect(await t.h.request(`/api/v1/agent-accounts/${target}`, { method: "DELETE", cookie: t.alice.cookie, headers: { "idempotency-key": crypto.randomUUID() }, body: { expectedRevision: 1 } }));
    await button(page, "使用服务默认邮箱").click(); await page.getByRole("alert").waitFor();
    assert.equal(await select(page, "任务发件邮箱").inputValue(), ""); assert.equal(await button(page, "创建并排队发送 Agent 任务").isDisabled(), true);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_threads").first("n"), 0); assert.equal(t.opens.length, 0);
  } finally { await browser?.close(); await t.close(); }
});

test("Chrome: unknown default writes keep the original body and key; replay cannot overwrite a newer cleared default", { timeout: 90000 }, async () => {
  const t = await agentTasksFixture(true); let browser, page;
  try {
    browser = await chrome(); page = await browser.newPage(); page.setDefaultTimeout(10000); await login(page, t.h, t.alice, "Agent 服务");
    await button(page, "编辑服务 远程任务服务").click(); await button(page, "加载 Agent 发件邮箱").click(); await select(page, "服务默认发件邮箱").selectOption(t.accountId);
    const writes = [];
    await page.route(`**/api/v1/agent-services/${t.serviceId}`, async route => {
      if (route.request().method() !== "PATCH") return route.continue();
      writes.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() });
      await route.fetch(); return route.fulfill({ status: 200, json: {} });
    });
    page.once("dialog", dialog => dialog.accept()); await button(page, "保存服务修改").click(); await button(page, "核对原服务操作").waitFor();
    assert.equal(await select(page, "服务默认发件邮箱").isDisabled(), true); assert.equal(writes[0].body.defaultSenderAccountId, t.accountId);
    expect(await serviceWrite(t.h, t.alice, "PATCH", t.serviceId, { expectedVersion: 2, defaultSenderAccountId: null }));
    await page.getByRole("navigation").getByRole("button", { name: "邮箱管理", exact: true }).click();
    await page.getByRole("navigation").getByRole("button", { name: "Agent 服务", exact: true }).click();
    assert.equal(await page.getByTestId("agent-service-operation-key").textContent(), writes[0].key);
    await button(page, "核对原服务操作").click();
    await page.waitForFunction(() => [...document.querySelectorAll("small")].some(row => row.textContent?.includes("版本 3")));
    assert.equal(writes.length, 1); assert.equal(expect(await getService(t.h, t.alice, t.serviceId)).service.defaultSenderAccountId, null);
    await button(page, "编辑服务 远程任务服务").click(); assert.equal(await select(page, "服务默认发件邮箱").inputValue(), "");
  } finally { await browser?.close(); await t.close(); }
});
