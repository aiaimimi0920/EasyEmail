import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { PASSWORD } from "./runtime-harness.mjs";
import { agentWrite, agentAccountInput, expect } from "./agent-accounts-fixture.mjs";
import { agentSmtpFixture, AGENT_SMTP_PASSWORD } from "./agent-smtp-fixture.mjs";

const executablePath = process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
async function login(page, user) {
  await page.getByLabel("用户名", { exact: true }).fill(user.username); await page.getByLabel("密码", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("navigation").getByRole("button", { name: "Agent 邮箱", exact: true }).click();
}
async function open(page, t) {
  await page.goto(t.h.baseUrl.href); await login(page, t.alice);
  const account = page.getByRole("region", { name: "Agent 邮箱", exact: true });
  await account.getByRole("button", { name: "Agent 专用邮箱", exact: true }).click();
  const smtp = page.getByRole("region", { name: "Agent 邮箱 SMTP", exact: true });
  await smtp.getByText("SMTP 凭据：未保存 · 版本 0", { exact: true }).waitFor();
  return { account, smtp };
}
async function fill(smtp) {
  await smtp.getByLabel("Agent SMTP 用户名", { exact: true }).fill("Agent-SMTP");
  await smtp.getByLabel("Agent SMTP 应用密码", { exact: true }).fill(AGENT_SMTP_PASSWORD);
  await smtp.getByLabel("启用 Agent SMTP 配置", { exact: true }).check();
}

test("Chrome: Agent SMTP private config, parent interlock, original-key reconciliation, forget, removal and user isolation", { timeout: 90000 }, async () => {
  const t = await agentSmtpFixture({ browser: true }); let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true }); const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); page.setDefaultTimeout(10000);
    const errors = [], external = []; page.on("pageerror", e => errors.push(e.message)); page.on("request", r => { if (!r.url().startsWith(t.h.baseUrl.origin)) external.push(r.url()); });
    const { account, smtp } = await open(page, t); await fill(smtp);
    for (const name of ["保存 Agent 邮箱", "测试 Agent IMAP 连接", "移除 Agent 邮箱", "添加 Agent 邮箱", "刷新 Agent 邮箱"])
      assert.equal(await account.getByRole("button", { name, exact: true }).isDisabled(), true, name);
    let writes = 0, reads = 0;
    await page.route(`**/api/v1/agent-accounts/${t.id}/smtp`, async route => {
      if (route.request().method() !== "PUT") return route.continue(); writes++; await route.fetch(); return route.abort("failed");
    });
    await page.route("**/api/v1/agent-smtp-operations/*", route => { reads++; return route.continue(); });
    await smtp.getByRole("button", { name: "保存 Agent SMTP 配置", exact: true }).click();
    await smtp.getByRole("button", { name: "核对原 Agent SMTP 配置", exact: true }).waitFor();
    assert.equal(await smtp.getByLabel("Agent SMTP 应用密码", { exact: true }).inputValue(), "");
    await page.getByRole("navigation").getByRole("button", { name: "Agent 服务", exact: true }).click();
    await page.getByRole("navigation").getByRole("button", { name: "Agent 邮箱", exact: true }).click();
    await smtp.getByRole("button", { name: "核对原 Agent SMTP 配置", exact: true }).click();
    await smtp.getByText("SMTP 凭据：已加密保存 · 版本 1", { exact: true }).waitFor(); assert.equal(writes, 1); assert.equal(reads, 1);
    await page.unroute(`**/api/v1/agent-accounts/${t.id}/smtp`);
    await smtp.getByLabel("启用 Agent SMTP 配置", { exact: true }).uncheck(); await smtp.getByLabel("忘记 Agent SMTP 凭据（须同时关闭配置）", { exact: true }).check();
    await smtp.getByRole("button", { name: "保存 Agent SMTP 配置", exact: true }).click(); await smtp.getByText("SMTP 凭据：未保存 · 版本 2", { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(t.h.directory, "agent-smtp-mobile.png"), fullPage: true });
    await page.getByRole("combobox", { name: "权限", exact: true }).selectOption("agent-accounts");
    await page.getByLabel("名称", { exact: true }).fill("Agent SMTP config program"); await page.getByRole("button", { name: "创建 Key", exact: true }).click();
    const token = await page.getByTestId("new-key").textContent(); expect(await t.h.request(t.route, { token }));
    expect(await t.h.request(`/api/v1/normal-accounts/${t.id}/smtp`, { token }), 403);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.equal((await page.locator("body").textContent()).includes(AGENT_SMTP_PASSWORD), false);
    page.once("dialog", d => d.dismiss()); await account.getByRole("button", { name: "移除 Agent 邮箱", exact: true }).click();
    assert.equal(await t.h.db.prepare("SELECT deleted_at FROM agent_accounts WHERE id=?").bind(t.id).first("deleted_at"), null);
    await fill(smtp); await smtp.getByRole("button", { name: "保存 Agent SMTP 配置", exact: true }).click();
    await smtp.getByText("SMTP 凭据：已加密保存 · 版本 3", { exact: true }).waitFor();
    page.once("dialog", d => d.accept()); await account.getByRole("button", { name: "移除 Agent 邮箱", exact: true }).click();
    await account.getByText("暂无 Agent 邮箱", { exact: true }).waitFor();
    assert.equal(await t.h.db.prepare("SELECT credential_cipher FROM agent_smtp_configs WHERE account_id=?").bind(t.id).first("credential_cipher"), null);
    await page.getByRole("button", { name: "退出登录", exact: true }).click(); await login(page, t.bob);
    await account.getByText("暂无 Agent 邮箱", { exact: true }).waitFor(); assert.equal(await page.getByRole("region", { name: "Agent 邮箱 SMTP", exact: true }).count(), 0);
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
  } finally { await browser?.close(); await t.close(); }
});

test("Chrome: malformed SMTP receipts retain original body/key across 404 retry and reject wrong identity before unlocking", { timeout: 90000 }, async () => {
  const t = await agentSmtpFixture({ browser: true }); let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true }); const page = await browser.newPage(); page.setDefaultTimeout(10000);
    const { account, smtp } = await open(page, t); await fill(smtp); const keys = [], bodies = []; let count = 0, mode = "absent";
    await page.route(`**/api/v1/agent-accounts/${t.id}/smtp`, async route => {
      if (route.request().method() !== "PUT") return route.continue(); count++; keys.push(route.request().headers()["idempotency-key"]); bodies.push(route.request().postData());
      if (count === 1) return route.abort("failed"); await route.fetch(); return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    await page.route("**/api/v1/agent-smtp-operations/*", async route => {
      if (mode === "absent" || mode === "valid") return route.continue();
      if (mode === "invalid") return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      const response = await route.fetch(), value = await response.json(); value.operation.accountId = crypto.randomUUID(); return route.fulfill({ response, json: value });
    });
    await smtp.getByRole("button", { name: "保存 Agent SMTP 配置", exact: true }).click();
    const recover = smtp.getByRole("button", { name: "核对原 Agent SMTP 配置", exact: true }); await recover.waitFor();
    for (const next of ["absent", "invalid", "mismatch"]) {
      mode = next; await recover.click(); await smtp.getByRole("alert").filter({ hasText: "回执不匹配" }).waitFor();
      assert.equal(await account.getByRole("button", { name: "移除 Agent 邮箱", exact: true }).isDisabled(), true);
    }
    assert.equal(keys.length, 2); assert.equal(new Set(keys).size, 1); assert.equal(bodies[0], bodies[1]);
    mode = "valid"; await recover.click(); await smtp.getByText("SMTP 凭据：已加密保存 · 版本 1", { exact: true }).waitFor();
    assert.equal(keys.length, 2); assert.equal(await smtp.getByLabel("Agent SMTP 应用密码", { exact: true }).inputValue(), "");
  } finally { await browser?.close(); await t.close(); }
});

test("Chrome: late SMTP reads cannot replace refresh and discarded stale-parent edits do not trap account navigation", { timeout: 90000 }, async () => {
  const t = await agentSmtpFixture({ browser: true }); let browser, release;
  try {
    browser = await chromium.launch({ executablePath, headless: true }); const page = await browser.newPage(); page.setDefaultTimeout(10000);
    let first = true, enter; const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
    await page.route(`**/api/v1/agent-accounts/${t.id}/smtp`, async route => {
      if (!first || route.request().method() !== "GET") return route.continue(); first = false;
      const response = await route.fetch(); enter(); await held; return route.fulfill({ response });
    });
    await page.goto(t.h.baseUrl.href); await login(page, t.alice); const account = page.getByRole("region", { name: "Agent 邮箱", exact: true });
    await account.getByRole("button", { name: "Agent 专用邮箱", exact: true }).click(); await entered;
    expect(await t.configure()); const smtp = page.getByRole("region", { name: "Agent 邮箱 SMTP", exact: true });
    await smtp.getByRole("button", { name: "刷新 Agent SMTP 配置", exact: true }).click(); await smtp.getByText("SMTP 凭据：已加密保存 · 版本 1", { exact: true }).waitFor(); release();
    await smtp.getByLabel("Agent SMTP 用户名", { exact: true }).fill("Unsaved");
    expect(await agentWrite(t.h, t.alice, t.id, { ...agentAccountInput, expectedRevision: 1, password: undefined, displayName: "Remote current" }));
    await smtp.getByRole("button", { name: "保存 Agent SMTP 配置", exact: true }).click(); await smtp.getByRole("alert").filter({ hasText: "已变化" }).waitFor();
    page.once("dialog", d => d.accept()); await smtp.getByRole("button", { name: "刷新 Agent SMTP 配置", exact: true }).click();
    await smtp.getByRole("alert").filter({ hasText: "Agent 邮箱已变化" }).waitFor();
    await account.getByRole("button", { name: "刷新 Agent 邮箱", exact: true }).click(); await account.getByText("凭据：已加密保存 · 版本 2", { exact: true }).waitFor();
    await smtp.getByRole("status").filter({ hasText: "启用 SMTP 须重新提供应用密码" }).waitFor();
    assert.equal(await smtp.getByLabel("Agent SMTP 用户名", { exact: true }).inputValue(), "Agent-SMTP");
  } finally { release?.(); await browser?.close(); await t.close(); }
});

test("Chrome: absent unknown SMTP request plus obsolete parent CAS reconciles absence before releasing the original lock", { timeout: 90000 }, async () => {
  const t = await agentSmtpFixture({ browser: true }); let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true }); const page = await browser.newPage(); page.setDefaultTimeout(10000);
    const { account, smtp } = await open(page, t); await fill(smtp); const keys = [], bodies = []; let reads = 0;
    await page.route(`**/api/v1/agent-accounts/${t.id}/smtp`, route => {
      if (route.request().method() !== "PUT") return route.continue(); keys.push(route.request().headers()["idempotency-key"]); bodies.push(route.request().postData());
      return keys.length === 1 ? route.abort("failed") : route.continue();
    });
    await page.route("**/api/v1/agent-smtp-operations/*", route => { reads++; return route.continue(); });
    await smtp.getByRole("button", { name: "保存 Agent SMTP 配置", exact: true }).click();
    const recover = smtp.getByRole("button", { name: "核对原 Agent SMTP 配置", exact: true }); await recover.waitFor();
    expect(await agentWrite(t.h, t.alice, t.id, { ...agentAccountInput, expectedRevision: 1, password: undefined, displayName: "Concurrent parent" }));
    await recover.click(); await smtp.getByRole("alert").filter({ hasText: "已变化" }).waitFor();
    await recover.waitFor({ state: "hidden" }); assert.equal(reads, 2); assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]); assert.equal(bodies[0], bodies[1]);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_smtp_operations").first("n"), 0);
    page.once("dialog", d => d.accept()); await smtp.getByRole("button", { name: "刷新 Agent SMTP 配置", exact: true }).click();
    await smtp.getByRole("alert").filter({ hasText: "Agent 邮箱已变化" }).waitFor();
    await account.getByRole("button", { name: "刷新 Agent 邮箱", exact: true }).click();
    await account.getByText("凭据：已加密保存 · 版本 2", { exact: true }).waitFor();
    await smtp.getByText("SMTP 凭据：未保存 · 版本 0", { exact: true }).waitFor(); await fill(smtp);
    await smtp.getByRole("button", { name: "保存 Agent SMTP 配置", exact: true }).click(); await smtp.getByText("SMTP 凭据：已加密保存 · 版本 1", { exact: true }).waitFor();
    assert.notEqual(keys[2], keys[0]); assert.equal(JSON.parse(bodies[2]).expectedRevision, 2);
  } finally { await browser?.close(); await t.close(); }
});

test("Chrome: stale-CAS reconciliation retains uncertainty on failed checks and confirms a late original receipt", { timeout: 90000 }, async () => {
  const t = await agentSmtpFixture({ browser: true }); let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true }); const page = await browser.newPage(); page.setDefaultTimeout(10000);
    const { account, smtp } = await open(page, t); await fill(smtp);
    const keys = [], bodies = []; let mode = "compound", reads = 0, attempts = 0;
    await page.route(`**/api/v1/agent-accounts/${t.id}/smtp`, async route => {
      if (route.request().method() !== "PUT") return route.continue();
      keys.push(route.request().headers()["idempotency-key"]); bodies.push(route.request().postData());
      if (keys.length === 1) { await route.fetch(); return route.abort("failed"); }
      return route.fulfill({ status: 409, json: { error: { code: mode === "compound" ? "agent_smtp_changed_or_limit" : "agent_smtp_changed" } } });
    });
    await page.route("**/api/v1/agent-smtp-operations/*", route => {
      reads++;
      if (reads % 2 === 1 || mode === "compound") return route.fulfill({ status: 404, json: { error: { code: "not_found" } } });
      if (mode === "network") return route.abort("failed");
      if (mode === "invalid") return route.fulfill({ status: 200, json: {} });
      if (mode === "forbidden") return route.fulfill({ status: 403, json: { error: { code: "forbidden" } } });
      return route.continue();
    });
    await smtp.getByRole("button", { name: "保存 Agent SMTP 配置", exact: true }).click();
    const recover = smtp.getByRole("button", { name: "核对原 Agent SMTP 配置", exact: true }); await recover.waitFor();
    for (const next of ["compound", "network", "invalid", "forbidden"]) {
      mode = next; reads = 0; await recover.click(); attempts++;
      await page.waitForFunction(() => {
        const button = [...document.querySelectorAll("button")].find(row => row.textContent === "核对原 Agent SMTP 配置");
        return button && !button.disabled;
      });
      assert.equal(reads, next === "compound" ? 1 : 2);
      assert.equal(await account.getByRole("button", { name: "移除 Agent 邮箱", exact: true }).isDisabled(), true);
      assert.equal(await smtp.getByRole("button", { name: "刷新 Agent SMTP 配置", exact: true }).isDisabled(), true);
      assert.equal(keys.length, attempts + 1); assert.equal(new Set(keys).size, 1); assert.equal(new Set(bodies).size, 1);
    }
    mode = "valid"; reads = 0; await recover.click();
    await smtp.getByText("SMTP 凭据：已加密保存 · 版本 1", { exact: true }).waitFor(); await recover.waitFor({ state: "hidden" });
    assert.equal(reads, 2); assert.equal(new Set(keys).size, 1); assert.equal(new Set(bodies).size, 1);
    assert.equal(await account.getByRole("button", { name: "移除 Agent 邮箱", exact: true }).isDisabled(), false);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_smtp_operations").first("n"), 1);
  } finally { await browser?.close(); await t.close(); }
});
