import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { PASSWORD } from "./runtime-harness.mjs";
import { agentServicesFixture, serviceBody, createService, serviceWrite, getService, expect } from "./agent-services-fixture.mjs";

const field = (page, name) => page.getByLabel(name, { exact: true });
const button = (page, name) => page.getByRole("button", { name, exact: true });
const select = (page, name) => page.getByRole("combobox", { name, exact: true });
const loaded = (page, count) => page.getByRole("status").filter({ hasText: `已加载 ${count} 个远程服务` }).waitFor();
async function login(page, h, user) {
  await page.goto(h.baseUrl.href); await field(page, "用户名").fill(user.username); await field(page, "密码").fill(PASSWORD);
  await button(page, "登录").click(); await button(page, "Agent 服务").click();
}
const chrome = () => chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });

test("Chrome: service CRUD, explicit trust confirmation, conflict preservation, read-only receipt recovery and account isolation", { timeout: 120000 }, async () => {
  const f = await agentServicesFixture({}, true); const { h, alice, bob } = f; let browser, page;
  try {
    browser = await chrome(); page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); page.setDefaultTimeout(10000);
    const errors = [], external = [], posts = [], deletes = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (!request.url().startsWith(h.baseUrl.origin)) external.push(request.url()); });
    await login(page, h, alice); await loaded(page, 0);
    await field(page, "服务名称").fill("研究服务"); await field(page, "服务邮箱").fill("RESEARCH@Example.Test");
    await field(page, "服务描述").fill('<img src=x onerror="window.agentExecuted=true">');
    await page.route("**/api/v1/agent-services", async route => {
      if (route.request().method() !== "POST") return route.continue();
      posts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
      await route.fetch(); await route.abort("connectionfailed");
    });
    await button(page, "新增远程服务").click(); await button(page, "核对原服务操作").waitFor();
    const key = await page.getByTestId("agent-service-operation-key").textContent(); assert.equal(await field(page, "服务名称").isDisabled(), true);
    const id = await h.db.prepare("SELECT id FROM agent_services WHERE user_id=? AND email_address='research@example.test'").bind(alice.id).first("id");
    expect(await serviceWrite(h, alice, "PATCH", id, { expectedVersion: 1, description: "另一设备的最新说明", trustLevel: "blocked", status: "disabled" }));
    await button(page, "邮箱管理").click(); await button(page, "Agent 服务").click();
    assert.equal(await page.getByTestId("agent-service-operation-key").textContent(), key);
    await button(page, "核对原服务操作").click(); await button(page, "编辑服务 研究服务").waitFor();
    assert.equal(posts.length, 1, "Committed lost response is reconciled with GET, not another mutation");
    await page.getByText("另一设备的最新说明", { exact: true }).waitFor(); await page.unroute("**/api/v1/agent-services");
    await button(page, "编辑服务 研究服务").click(); assert.equal(await field(page, "服务邮箱").isDisabled(), true);
    await field(page, "服务名称").fill("保留的冲突编辑"); await select(page, "信任级别").selectOption("trusted");
    page.once("dialog", dialog => dialog.dismiss()); await button(page, "保存服务修改").click();
    assert.equal(expect(await getService(h, alice, id)).service.version, 2);
    expect(await serviceWrite(h, alice, "PATCH", id, { expectedVersion: 2, description: "并发的新说明" }));
    page.once("dialog", dialog => dialog.accept()); await button(page, "保存服务修改").click();
    await page.getByRole("alert").filter({ hasText: "远程服务已变化" }).waitFor();
    assert.equal(await field(page, "服务名称").inputValue(), "保留的冲突编辑");
    await button(page, "取消编辑服务").click(); await button(page, "刷新远程服务").click(); await page.getByText("并发的新说明", { exact: true }).waitFor();
    await button(page, "编辑服务 研究服务").click(); await select(page, "信任级别").selectOption("trusted"); await select(page, "服务状态").selectOption("archived");
    page.once("dialog", dialog => dialog.accept()); await button(page, "保存服务修改").click(); await field(page, "服务名称").waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll("small")].some(element => element.textContent?.includes("信任 · 归档 · 版本 4")));
    page.once("dialog", dialog => dialog.dismiss()); await button(page, "删除服务 研究服务").click(); expect(await getService(h, alice, id));
    await page.route("**/api/v1/agent-services/*", async route => {
      if (route.request().method() !== "DELETE") return route.continue();
      deletes.push(route.request().headers()["idempotency-key"]); await route.fetch(); await route.abort("connectionfailed");
    });
    page.once("dialog", dialog => dialog.accept()); await button(page, "删除服务 研究服务").click(); await button(page, "核对原服务操作").waitFor();
    const replacement = expect(await createService(h, alice, serviceBody("research@example.test", "同地址新服务")), 201).operation.serviceId;
    await button(page, "核对原服务操作").click(); await button(page, "编辑服务 同地址新服务").waitFor(); assert.equal(deletes.length, 1);
    expect(await getService(h, alice, replacement)); await page.unroute("**/api/v1/agent-services/*");
    await select(page, "权限").selectOption("agent-services"); await field(page, "名称").fill("service automation"); await button(page, "创建 Key").click();
    const token = await page.getByTestId("new-key").textContent(); expect(await h.request("/api/v1/agent-services", { token, origin: null }));
    expect(await h.request("/api/v1/mailboxes", { token, origin: null }), 403);
    await page.reload(); await button(page, "Agent 服务").click(); await button(page, "编辑服务 同地址新服务").waitFor();
    await button(page, "退出登录").click(); await login(page, h, bob); await loaded(page, 0);
    assert.equal(await field(page, "服务邮箱").inputValue(), "");
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(h.directory, "agent-services-mobile.png"), fullPage: true });
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.equal(await page.evaluate(() => window.agentExecuted), undefined);
    assert.deepEqual(errors, []); assert.deepEqual(external, []); console.log(`Agent services Chrome evidence: ${h.directory}`);
  } catch (error) {
    if (page) { console.error(await page.locator("body").ariaSnapshot()); await page.screenshot({ path: path.join(h.directory, "agent-services-failure.png"), fullPage: true }); }
    throw error;
  } finally { await browser?.close(); await f.close(); }
});

test("Chrome: uncommitted lost requests retain the original key, and late pagination cannot replace a fresh view", { timeout: 90000 }, async () => {
  const f = await agentServicesFixture({}, true); const { h, alice } = f; let browser, page, release;
  try {
    browser = await chrome(); page = await browser.newPage(); page.setDefaultTimeout(10000);
    await login(page, h, alice); await loaded(page, 0);
    const writes = []; let drop = true;
    await page.route("**/api/v1/agent-services", async route => {
      if (route.request().method() !== "POST") return route.continue();
      writes.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
      if (drop) { drop = false; await route.abort("connectionfailed"); } else await route.continue();
    });
    await field(page, "服务名称").fill("恢复原请求"); await field(page, "服务邮箱").fill("recover@example.test");
    await button(page, "新增远程服务").click(); await button(page, "核对原服务操作").waitFor();
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM agent_services").first("n"), 0);
    await button(page, "核对原服务操作").click(); await button(page, "编辑服务 恢复原请求").waitFor(); assert.deepEqual(writes[0], writes[1]);
    await page.unroute("**/api/v1/agent-services");
    await h.db.batch(Array.from({ length: 27 }, (_, i) => h.db.prepare(`INSERT INTO agent_services
      (user_id,id,display_name,email_address,description,service_kind,trust_level,status,version,created_at,updated_at)
      VALUES(?,?,?,?,NULL,'email_agent','restricted','disabled',1,unixepoch(),unixepoch())`)
      .bind(alice.id, crypto.randomUUID(), `分页服务${i}`, `page-${i}@example.test`)));
    await button(page, "刷新远程服务").click(); await loaded(page, 25);
    let entered; const enteredPromise = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    await page.route("**/api/v1/agent-services?**", async route => {
      if (!new URL(route.request().url()).searchParams.has("cursor")) return route.continue();
      const response = await route.fetch(); entered(); await gate; await route.fulfill({ response });
    });
    await button(page, "加载更多远程服务").click(); await enteredPromise;
    await button(page, "邮箱管理").click(); await button(page, "Agent 服务").click(); await loaded(page, 25); release();
    await page.waitForResponse(response => new URL(response.url()).searchParams.has("cursor"));
    await loaded(page, 25); await page.unroute("**/api/v1/agent-services?**");
    await button(page, "加载更多远程服务").click(); await loaded(page, 28);
    await field(page, "搜索远程服务").fill("分页服务"); await select(page, "筛选信任级别").selectOption("restricted");
    await select(page, "筛选服务状态").selectOption("disabled"); await button(page, "搜索远程服务").click(); await loaded(page, 25);
    await button(page, "加载更多远程服务").click(); await loaded(page, 27);
    console.log(`Agent service recovery/pagination Chrome evidence: ${h.directory}`);
  } finally { release?.(); await browser?.close(); await f.close(); }
});

test("Chrome: malformed or mismatched successful receipts remain unknown; untrusted descriptions render only as text", { timeout: 90000 }, async () => {
  const f = await agentServicesFixture({}, true); const { h, alice } = f; let browser, page;
  try {
    browser = await chrome(); page = await browser.newPage(); page.setDefaultTimeout(10000);
    const external = [], errors = []; let posts = 0;
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (!request.url().startsWith(h.baseUrl.origin)) external.push(request.url()); });
    await login(page, h, alice); await loaded(page, 0);
    const payload = '<img src="https://attacker.example.test/x" onerror="window.agentExecuted=true">';
    await field(page, "服务名称").fill("回执核验服务"); await field(page, "服务邮箱").fill("receipt-validation@example.test"); await field(page, "服务描述").fill(payload);
    await page.route("**/api/v1/agent-services", async route => {
      if (route.request().method() !== "POST") return route.continue();
      posts++; await route.fetch(); await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    await button(page, "新增远程服务").click(); await button(page, "核对原服务操作").waitFor();
    await page.getByRole("alert").filter({ hasText: "回执未通过核验" }).waitFor();
    const key = await page.getByTestId("agent-service-operation-key").textContent();
    const good = expect(await h.request(`/api/v1/agent-service-operations/${key}`, { cookie: alice.cookie })).operation;
    for (const operation of [{}, { ...good, requestKey: crypto.randomUUID() }, { ...good, kind: "DELETE" }, { ...good, version: 9 }, { ...good, deleted: true }]) {
      await page.route("**/api/v1/agent-service-operations/*", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ operation }) }));
      const response = page.waitForResponse(result => result.url().includes("/agent-service-operations/"));
      await button(page, "核对原服务操作").click(); await response; await button(page, "核对原服务操作").waitFor();
      assert.equal(await page.getByTestId("agent-service-operation-key").textContent(), key);
      assert.equal(await field(page, "服务名称").isDisabled(), true); await page.unroute("**/api/v1/agent-service-operations/*");
    }
    await button(page, "核对原服务操作").click(); await button(page, "编辑服务 回执核验服务").waitFor();
    await page.getByText(payload, { exact: true }).waitFor();
    assert.equal(await page.getByRole("region", { name: "Agent 远程服务目录" }).locator("img").count(), 0);
    assert.equal(await page.evaluate(() => window.agentExecuted), undefined);
    assert.equal(posts, 1); assert.deepEqual(external, []); assert.deepEqual(errors, []);
    console.log(`Agent service receipt/XSS Chrome evidence: ${h.directory}`);
  } finally { await browser?.close(); await f.close(); }
});
