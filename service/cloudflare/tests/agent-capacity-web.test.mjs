import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { agentInboxFixture } from "./agent-inbox-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";
import { PASSWORD } from "./runtime-harness.mjs";
import { seedAgentRequestHistory, seedAgentEmptyHistory, exhaustAgentAdmission } from "./agent-capacity-fixture.mjs";

test("Chrome: Agent receive survives large history, 429 leaves no intent, and lost empty success reconciles without another POST", { timeout: 90000 }, async () => {
  const t = await agentInboxFixture({ browser: true }); let browser, page;
  try {
    const first = expect(await t.receive()).operation;
    await seedAgentRequestHistory(t); await seedAgentEmptyHistory(t, first);
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    page = await browser.newPage({ viewport: { width: 1100, height: 900 } }); page.setDefaultTimeout(12000);
    const errors = [], external = [], keys = []; let lose = false;
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (!request.url().startsWith(t.h.baseUrl.origin)) external.push(request.url()); });
    await page.goto(t.h.baseUrl.href); await page.getByLabel("用户名", { exact: true }).fill(t.alice.username);
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByRole("navigation").getByRole("button", { name: "Agent 邮箱", exact: true }).click();
    const accounts = page.getByRole("region", { name: "Agent 邮箱", exact: true });
    await accounts.getByRole("button", { name: "普通邮箱", exact: true }).click();
    const region = accounts.getByRole("region", { name: "Agent 收件", exact: true });
    await page.route(`**${t.base}/sync`, async route => {
      keys.push(route.request().headers()["idempotency-key"]);
      if (!lose) return route.continue(); await route.fetch(); return route.abort("failed");
    });
    const before = await t.h.db.prepare("SELECT COUNT(*) n FROM agent_inbox_requests").first("n");
    await exhaustAgentAdmission(t); await region.getByRole("button", { name: "同步 Agent 邮箱", exact: true }).click();
    await region.getByRole("alert").filter({ hasText: "操作过于频繁" }).waitFor();
    assert.equal(await region.getByRole("button", { name: "核对原 Agent 同步", exact: true }).count(), 0);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_inbox_requests").first("n"), before); assert.equal(t.opens.length, 1);
    assert.equal(await accounts.getByRole("button", { name: "移除 Agent 邮箱", exact: true }).isDisabled(), false);
    await t.h.resetLimits(); lose = true; await region.getByRole("button", { name: "同步 Agent 邮箱", exact: true }).click();
    const recover = region.getByRole("button", { name: "核对原 Agent 同步", exact: true }); await recover.waitFor();
    await region.getByRole("alert").filter({ hasText: "连接失败" }).waitFor();
    assert.equal(keys.length, 2); assert.notEqual(keys[0], keys[1]); assert.equal(t.opens.length, 2);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_inbox_requests").first("n"), before + 1);
    await exhaustAgentAdmission(t); let deniedRead = true;
    await page.route(`**${t.base}/sync-requests/*`, route => deniedRead
      ? route.fulfill({ status: 429, json: { error: { code: "rate_limited" } } }) : route.continue());
    await recover.click(); await region.getByRole("alert").filter({ hasText: "操作过于频繁" }).waitFor();
    assert.equal(keys.length, 2); assert.equal(await recover.count(), 1);
    assert.equal(await accounts.getByRole("button", { name: "移除 Agent 邮箱", exact: true }).isDisabled(), true);
    deniedRead = false; await recover.click(); await region.getByRole("status").filter({ hasText: "本批保存 0 封" }).waitFor();
    assert.equal(keys.length, 2); assert.equal(t.opens.length, 2);
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "移除 Agent 邮箱" && !button.disabled));
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(t.h.directory, "agent-capacity-mobile.png"), fullPage: true });
    await page.reload(); await page.getByRole("navigation").getByRole("button", { name: "Agent 邮箱", exact: true }).click();
    await accounts.getByRole("button", { name: "普通邮箱", exact: true }).click(); await region.getByRole("button", { name: "同步 Agent 邮箱", exact: true }).waitFor();
    assert.equal(t.opens.length, 2); assert.deepEqual(errors, []); assert.deepEqual(external, []);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  } catch (error) { if (page) console.error(await page.locator("body").ariaSnapshot()); throw error; }
  finally { await browser?.close(); await t.close(); }
});
