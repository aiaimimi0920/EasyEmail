import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { PASSWORD } from "./runtime-harness.mjs";
import { normalFixture, IMAP_PASSWORD, normalInput } from "./normal-imap-fixture.mjs";
import { agentWrite, expect } from "./agent-accounts-fixture.mjs";

const executablePath = process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
async function login(page, user) {
  await page.getByLabel("用户名", { exact: true }).fill(user.username);
  await page.getByLabel("密码", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("navigation").getByRole("button", { name: "Agent 邮箱", exact: true }).click();
}
async function fill(region, name = "Agent 专用测试邮箱") {
  await region.getByLabel("邮箱地址", { exact: true }).fill("alice@example.test");
  await region.getByLabel("邮箱名称", { exact: true }).fill(name);
  await region.getByLabel("IMAP 用户名", { exact: true }).fill("Alice");
  await region.getByLabel("IMAP 应用密码", { exact: true }).fill(IMAP_PASSWORD);
}

test("Chrome: independent Agent config, read-only connection, lost-response reconciliation, credentials, user isolation and remove confirmation", { timeout: 90000 }, async () => {
  const t = await normalFixture(true), { h, alice } = t; let browser, page;
  try {
    const bob = await h.register("agent-web-bob");
    browser = await chromium.launch({ executablePath, headless: true }); page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); page.setDefaultTimeout(10000);
    const errors = [], external = []; page.on("pageerror", e => errors.push(e.message));
    page.on("request", r => { if (!r.url().startsWith(h.baseUrl.origin)) external.push(r.url()); });
    await page.goto(h.baseUrl.href); await login(page, alice);
    const region = page.getByRole("region", { name: "Agent 邮箱", exact: true });
    await region.getByText("暂无 Agent 邮箱", { exact: true }).waitFor();
    await fill(region); await region.getByRole("button", { name: "保存 Agent 邮箱", exact: true }).click();
    await region.getByText("凭据：已加密保存 · 版本 1", { exact: true }).waitFor();
    assert.equal(await region.getByLabel("IMAP 应用密码", { exact: true }).inputValue(), "");
    assert.equal(await region.getByLabel("邮箱地址", { exact: true }).getAttribute("readonly"), "");
    const id = expect(await h.request("/api/v1/agent-accounts", { cookie: alice.cookie })).items[0].id;
    await region.getByRole("button", { name: "测试 Agent IMAP 连接", exact: true }).click();
    await region.getByRole("status").filter({ hasText: "本次检查未同步邮件" }).waitFor(); assert.equal(t.opens.length, 1);
    await region.getByLabel("邮箱名称", { exact: true }).fill("Agent 原键恢复");
    let writes = 0, reads = 0, originalKey;
    await page.route(`**/api/v1/agent-accounts/${id}`, async route => {
      if (route.request().method() !== "PUT") return route.continue();
      writes++; originalKey = route.request().headers()["idempotency-key"]; await route.fetch(); return route.abort("failed");
    });
    await page.route("**/api/v1/agent-account-operations/*", route => { reads++; return route.continue(); });
    await region.getByRole("button", { name: "保存 Agent 邮箱", exact: true }).click();
    await region.getByRole("button", { name: "核对原 Agent 账号操作", exact: true }).waitFor();
    await page.getByRole("navigation").getByRole("button", { name: "普通邮箱", exact: true }).click();
    const ordinary = page.getByRole("region", { name: "普通邮箱", exact: true });
    await ordinary.getByRole("button", { name: "普通邮箱", exact: true }).waitFor(); assert.equal((await ordinary.textContent()).includes("Agent 原键恢复"), false);
    await page.getByRole("navigation").getByRole("button", { name: "Agent 邮箱", exact: true }).click();
    assert.equal(await region.getByRole("button", { name: "保存 Agent 邮箱", exact: true }).isDisabled(), true);
    await region.getByRole("button", { name: "核对原 Agent 账号操作", exact: true }).click();
    await region.getByText("凭据：已加密保存 · 版本 2", { exact: true }).waitFor(); assert.equal(writes, 1); assert.equal(reads, 1); assert.ok(originalKey);
    await page.unroute(`**/api/v1/agent-accounts/${id}`);
    await page.getByRole("combobox", { name: "权限", exact: true }).selectOption("agent-accounts");
    await page.getByLabel("名称", { exact: true }).fill("Agent account program"); await page.getByRole("button", { name: "创建 Key", exact: true }).click();
    const token = await page.getByTestId("new-key").textContent(); expect(await h.request("/api/v1/agent-accounts", { token }));
    expect(await h.request("/api/v1/normal-accounts", { token }), 403);
    await page.getByRole("button", { name: "退出登录", exact: true }).click(); await login(page, bob);
    await region.getByText("暂无 Agent 邮箱", { exact: true }).waitFor(); assert.equal((await region.textContent()).includes("Agent 原键恢复"), false);
    await page.getByRole("button", { name: "退出登录", exact: true }).click(); await login(page, alice);
    await region.getByRole("button", { name: "Agent 原键恢复", exact: true }).click();
    page.once("dialog", dialog => dialog.dismiss()); await region.getByRole("button", { name: "移除 Agent 邮箱", exact: true }).click();
    assert.equal(await h.db.prepare("SELECT deleted_at FROM agent_accounts WHERE id=?").bind(id).first("deleted_at"), null);
    await region.getByLabel("允许平台连接", { exact: true }).uncheck(); await region.getByLabel("忘记凭据（须同时关闭连接）", { exact: true }).check();
    await region.getByRole("button", { name: "保存 Agent 邮箱", exact: true }).click();
    await region.getByText("凭据：未保存 · 版本 3", { exact: true }).waitFor();
    assert.equal(await region.getByRole("button", { name: "测试 Agent IMAP 连接", exact: true }).isDisabled(), true);
    page.once("dialog", dialog => dialog.accept()); await region.getByRole("button", { name: "移除 Agent 邮箱", exact: true }).click();
    await region.getByText("暂无 Agent 邮箱", { exact: true }).waitFor();
    assert.equal(await h.db.prepare("SELECT credential_cipher FROM agent_accounts WHERE id=?").bind(id).first("credential_cipher"), null);
    assert.ok(await h.db.prepare("SELECT credential_cipher FROM normal_accounts WHERE id=?").bind(t.id).first("credential_cipher"));
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(h.directory, "agent-accounts-mobile.png"), fullPage: true });
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.equal((await page.locator("body").textContent()).includes(IMAP_PASSWORD), false); assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log(`Agent account Chrome evidence: ${h.directory}`);
  } catch (error) { if (page) console.error(await page.locator("body").ariaSnapshot()); throw error; }
  finally { await browser?.close(); await t.close(); }
});

test("Chrome: Agent unknown and malformed receipts retain the immutable original request/key across recovery", { timeout: 90000 }, async () => {
  const t = await normalFixture(true), { h, alice } = t; let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true }); const page = await browser.newPage(); page.setDefaultTimeout(10000);
    await page.goto(h.baseUrl.href); await login(page, alice); const region = page.getByRole("region", { name: "Agent 邮箱", exact: true });
    await fill(region); const keys = [], bodies = []; let id, receiptMode = "absent", submit = 0;
    await page.route("**/api/v1/agent-accounts/*", async route => {
      if (route.request().method() !== "PUT") return route.continue();
      keys.push(route.request().headers()["idempotency-key"]); bodies.push(route.request().postData()); id = route.request().url().split("/").at(-1); submit++;
      if (submit === 1) return route.abort("failed");
      await route.fetch(); return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    await page.route("**/api/v1/agent-account-operations/*", async route => {
      if (receiptMode === "absent" || receiptMode === "valid") return route.continue();
      if (receiptMode === "invalid") return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      const response = await route.fetch(), value = await response.json(); value.operation.accountId = crypto.randomUUID();
      return route.fulfill({ response, json: value });
    });
    await region.getByRole("button", { name: "保存 Agent 邮箱", exact: true }).click();
    const recover = region.getByRole("button", { name: "核对原 Agent 账号操作", exact: true }); await recover.waitFor();
    assert.equal(await region.getByLabel("IMAP 应用密码", { exact: true }).isDisabled(), true);
    await recover.click(); await region.getByRole("alert").filter({ hasText: "回执不匹配" }).waitFor();
    for (const mode of ["invalid", "mismatch"]) { receiptMode = mode; await recover.click(); await region.getByRole("alert").filter({ hasText: "回执不匹配" }).waitFor(); }
    assert.equal(keys.length, 2); assert.equal(new Set(keys).size, 1); assert.equal(bodies[0], bodies[1]);
    receiptMode = "valid"; await recover.click(); await region.getByText("凭据：已加密保存 · 版本 1", { exact: true }).waitFor();
    assert.equal(await region.getByLabel("IMAP 应用密码", { exact: true }).inputValue(), "");
    assert.equal(await h.db.prepare("SELECT revision FROM agent_accounts WHERE id=?").bind(id).first("revision"), 1);
    assert.equal(keys.length, 2); assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  } finally { await browser?.close(); await t.close(); }
});

test("Chrome: late initial Agent list cannot replace an explicit fresh reload or discard the endpoint form", { timeout: 90000 }, async () => {
  const t = await normalFixture(true), { h, alice } = t; let browser, release;
  try {
    const id = crypto.randomUUID(); expect(await agentWrite(h, alice, id, normalInput), 201);
    browser = await chromium.launch({ executablePath, headless: true }); const page = await browser.newPage(); page.setDefaultTimeout(10000);
    let first = true, enter; const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
    await page.route("**/api/v1/agent-accounts", async route => {
      if (!first || route.request().method() !== "GET") return route.continue(); first = false;
      const response = await route.fetch(); enter(); await held; return route.fulfill({ response });
    });
    await page.goto(h.baseUrl.href); await login(page, alice); await entered;
    expect(await agentWrite(h, alice, id, { ...normalInput, expectedRevision: 1, displayName: "最新 Agent 配置" }));
    const region = page.getByRole("region", { name: "Agent 邮箱", exact: true });
    await region.getByRole("button", { name: "刷新 Agent 邮箱", exact: true }).click();
    await region.getByRole("button", { name: "最新 Agent 配置", exact: true }).waitFor(); release();
    await region.getByLabel("IMAP 应用密码", { exact: true }).waitFor();
    assert.equal(await region.getByRole("button", { name: "普通邮箱", exact: true }).count(), 0);
    await region.getByRole("button", { name: "最新 Agent 配置", exact: true }).click();
    await region.getByText("凭据：已加密保存 · 版本 2", { exact: true }).waitFor();
  } finally { release?.(); await browser?.close(); await t.close(); }
});

test("Chrome: malformed or wrong-identity Agent IMAP results never report success or replace the selected account", { timeout: 90000 }, async () => {
  const t = await normalFixture(true), { h, alice } = t; let browser;
  try {
    const id = crypto.randomUUID(); expect(await agentWrite(h, alice, id, normalInput), 201);
    const account = expect(await h.request(`/api/v1/agent-accounts/${id}`, { cookie: alice.cookie })).account;
    const good = { account: { ...account, testedAt: Math.floor(Date.now() / 1000), testError: null, inboxUidValidity: "42", inboxMessages: 99 },
      test: { accountRevision: 1, authenticated: true, readOnly: true, capabilities: ["AUTH=PLAIN"], inbox: { path: "INBOX", uidValidity: "42", messages: 99 } } };
    browser = await chromium.launch({ executablePath, headless: true }); const page = await browser.newPage(); page.setDefaultTimeout(10000);
    await page.goto(h.baseUrl.href); await login(page, alice); const region = page.getByRole("region", { name: "Agent 邮箱", exact: true });
    await region.getByRole("button", { name: "普通邮箱", exact: true }).click();
    const bad = [{}, { ...good, account: { ...good.account, id: crypto.randomUUID() } }, { ...good, account: { ...good.account, revision: 2 } },
      { ...good, account: { ...good.account, scope: "normal" } }, { ...good, test: { ...good.test, authenticated: false } },
      { ...good, test: { ...good.test, readOnly: false } }, { ...good, test: { ...good.test, inbox: { ...good.test.inbox, uidValidity: "0" } } }];
    let value;
    await page.route(`**/api/v1/agent-accounts/${id}/test`, route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) }));
    for (const next of bad) {
      value = next; const response = page.waitForResponse(r => r.url().endsWith(`/${id}/test`));
      await region.getByRole("button", { name: "测试 Agent IMAP 连接", exact: true }).click(); await response;
      await region.getByRole("alert").filter({ hasText: "连接测试结果未确认" }).waitFor();
      assert.equal(await region.getByRole("status").filter({ hasText: "IMAP 认证与只读 INBOX 检查通过" }).count(), 0);
      assert.equal(await region.getByLabel("邮箱地址", { exact: true }).inputValue(), account.emailAddress);
      await region.getByText("凭据：已加密保存 · 版本 1", { exact: true }).waitFor();
    }
    assert.equal(t.opens.length, 0);
    await page.unroute(`**/api/v1/agent-accounts/${id}/test`);
    await region.getByRole("button", { name: "测试 Agent IMAP 连接", exact: true }).click();
    await region.getByRole("status").filter({ hasText: "IMAP 认证与只读 INBOX 检查通过" }).waitFor(); assert.equal(t.opens.length, 1);
  } finally { await browser?.close(); await t.close(); }
});
