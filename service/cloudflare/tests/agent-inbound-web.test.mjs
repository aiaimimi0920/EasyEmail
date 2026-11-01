import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { PASSWORD } from "./runtime-harness.mjs";
import { agentInboundFixture } from "./agent-inbound-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";

const executablePath = process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
async function open(page, t) {
  await page.goto(t.h.baseUrl.href); await page.getByLabel("用户名", { exact: true }).fill(t.alice.username);
  await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("navigation").getByRole("button", { name: "Agent 邮箱", exact: true }).click();
  const accounts = page.getByRole("region", { name: "Agent 邮箱", exact: true }); await accounts.getByRole("button", { name: "普通邮箱", exact: true }).click();
  const region = accounts.getByRole("region", { name: "Agent 收件", exact: true }); await region.getByRole("button", { name: "任务回复", exact: true }).click();
  await region.getByRole("combobox", { name: "入站线程服务", exact: true }).selectOption(t.serviceId); return region;
}
test("Chrome: explicit inbound creation, unverified message, real inbox thread lifecycle, least-privileged Key and 390px layout", { timeout: 90000 }, async () => {
  const t = await agentInboundFixture({ browser: true }); let browser, page;
  try {
    browser = await chromium.launch({ executablePath, headless: true }); page = await browser.newPage({ viewport: { width: 1100, height: 900 } }); page.setDefaultTimeout(10000);
    const errors = []; page.on("pageerror", error => errors.push(error.message)); const region = await open(page, t);
    page.once("dialog", dialog => dialog.dismiss()); await region.getByRole("button", { name: "创建入站线程", exact: true }).click();
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_inbound_threads").first("n"), 0);
    page.on("dialog", dialog => { assert.match(dialog.message(), /不发送邮件|不取消或重试派发/); return dialog.accept(); });
    await region.getByRole("button", { name: "创建入站线程", exact: true }).click(); await region.getByRole("status").filter({ hasText: "入站线程已创建" }).waitFor();
    await region.getByRole("combobox", { name: "Agent 处理筛选", exact: true }).selectOption("attention"); await region.getByText("暂无 Agent 邮件", { exact: true }).waitFor();
    await region.getByRole("combobox", { name: "Agent 处理筛选", exact: true }).selectOption("handled"); await region.getByRole("button", { name: "任务回复", exact: true }).click();
    await region.getByText("已建入站线程 · 发件身份未验证", { exact: true }).waitFor();
    const id = await t.h.db.prepare("SELECT id FROM agent_inbound_threads").first("id");
    await page.getByRole("navigation").getByRole("button", { name: "Agent 线程", exact: true }).click(); const threads = page.getByRole("region", { name: "Agent 线程", exact: true });
    await threads.getByRole("button", { name: `入站线程 · ${id}`, exact: true }).click(); const detail = threads.getByRole("article", { name: "Agent 线程详情", exact: true });
    const inbox = detail.getByRole("region", { name: "入站线程来信", exact: true }); await inbox.getByRole("button", { name: "任务回复", exact: true }).click();
    await inbox.getByText("已建入站线程 · 发件身份未验证", { exact: true }).waitFor();
    for (const [name, status] of [["标记人工完成", "人工已完成"], ["归档线程", "已归档"], ["恢复处理中", "处理中"]]) {
      await detail.getByRole("button", { name, exact: true }).click(); await detail.getByRole("status").filter({ hasText: status }).waitFor();
    }
    await page.getByRole("combobox", { name: "权限", exact: true }).selectOption("agent-inbound"); await page.getByLabel("名称", { exact: true }).fill("inbound metadata");
    await page.getByRole("button", { name: "创建 Key", exact: true }).click(); const token = await page.getByTestId("new-key").textContent();
    expect(await t.threads("", { token })); expect(await t.h.request("/api/v1/agent-tasks", { method: "POST", token, body: {} }), 403);
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(t.h.directory, "agent-inbound-mobile.png"), fullPage: true });
    assert.equal(t.opens.length, 1); assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_outgoing_messages").first("n"), 1);
    assert.deepEqual(errors, []); assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  } catch (error) { if (page) console.error(await page.locator("body").ariaSnapshot()); throw error; }
  finally { await browser?.close(); await t.close(); }
});

test("Chrome: unknown inbound creation survives tabs, holds one body/key, GETs receipt before retry and releases lock after confirmed refresh failure", { timeout: 90000 }, async () => {
  const t = await agentInboundFixture({ browser: true }); let browser, page;
  try {
    browser = await chromium.launch({ executablePath, headless: true }); page = await browser.newPage(); page.setDefaultTimeout(10000); page.on("dialog", dialog => dialog.accept());
    const region = await open(page, t), keys = [], bodies = []; let reads = 0, valid = false, failRefresh = false;
    await page.route(`**${t.base}/messages/${t.incoming.id}/inbound-thread`, async route => {
      keys.push(route.request().headers()["idempotency-key"]); bodies.push(route.request().postData());
      if (keys.length === 1) return route.abort("failed"); await route.fetch(); return route.fulfill({ status: 201, json: {} });
    });
    await page.route(`**${t.base}/inbound-thread-operations/*`, route => { reads++; return valid || reads === 1 ? route.continue() : route.fulfill({ status: 200, json: {} }); });
    await page.route(`**${t.base}/messages?*`, route => failRefresh ? route.fulfill({ status: 503, json: { error: { code: "synthetic_inbound_refresh_failed" } } }) : route.continue());
    await region.getByRole("button", { name: "创建入站线程", exact: true }).click(); const recover = region.getByRole("button", { name: "核对原入站创建", exact: true }); await recover.waitFor();
    assert.equal(await region.getByRole("combobox", { name: "Agent 处理筛选", exact: true }).isDisabled(), true);
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some(row => row.textContent === "移除 Agent 邮箱" && row.disabled));
    await page.getByRole("navigation").getByRole("button", { name: "Agent 服务", exact: true }).click(); await page.getByRole("navigation").getByRole("button", { name: "Agent 邮箱", exact: true }).click();
    await recover.click(); await region.getByRole("alert").filter({ hasText: "入站创建响应不匹配" }).waitFor(); await recover.click();
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some(row => row.textContent === "核对原入站创建" && !row.disabled));
    assert.equal(keys.length, 2); assert.equal(new Set(keys).size, 1); assert.equal(new Set(bodies).size, 1);
    valid = true; failRefresh = true; await recover.click(); await region.getByRole("alert").filter({ hasText: "synthetic_inbound_refresh_failed" }).waitFor();
    assert.equal(await recover.count(), 0); assert.equal(await region.getByRole("combobox", { name: "Agent 处理筛选", exact: true }).isEnabled(), true);
    assert.equal(keys.length, 2); assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_inbound_threads").first("n"), 1);
    failRefresh = false; await region.getByRole("button", { name: "刷新 Agent 缓存", exact: true }).click(); await region.getByRole("button", { name: "任务回复", exact: true }).click();
    await region.getByText("已建入站线程 · 发件身份未验证", { exact: true }).waitFor();
    const bob = await t.h.register("inbound-browser-bob"); await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await page.getByLabel("用户名", { exact: true }).fill(bob.username); await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByRole("navigation").getByRole("button", { name: "Agent 邮箱", exact: true }).click(); await page.getByText("暂无 Agent 邮箱", { exact: true }).waitFor();
    assert.equal(await region.count(), 0); assert.equal(t.opens.length, 1);
  } catch (error) { if (page) console.error(await page.locator("body").ariaSnapshot()); throw error; }
  finally { await browser?.close(); await t.close(); }
});
