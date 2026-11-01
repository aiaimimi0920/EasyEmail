import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { PASSWORD } from "./runtime-harness.mjs";
import { agentInboxFixture, agentReply } from "./agent-inbox-fixture.mjs";
import { agentAssociationFixture } from "./agent-inbox-association-fixture.mjs";
import { ATTACHMENT, multipartMessage } from "./normal-mime-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";

const executablePath = process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
async function open(page, t) {
  await page.goto(t.h.baseUrl.href); await page.getByLabel("用户名", { exact: true }).fill(t.alice.username);
  await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("navigation").getByRole("button", { name: "Agent 邮箱", exact: true }).click();
  const accounts = page.getByRole("region", { name: "Agent 邮箱", exact: true }); await accounts.getByRole("button", { name: "普通邮箱", exact: true }).click();
  return accounts.getByRole("region", { name: "Agent 收件", exact: true });
}

test("Chrome: Agent IMAP receive, isolated cache, inert HTML, digest-verified attachment, explicit API Key and mobile", { timeout: 90000 }, async () => {
  const t = await agentInboxFixture({ browser: true, messages: new Map([[1, multipartMessage()]]), uidNext: 2 }); let browser, page;
  try {
    browser = await chromium.launch({ executablePath, headless: true }); page = await browser.newPage({ viewport: { width: 1100, height: 900 } }); page.setDefaultTimeout(10000);
    const errors = [], external = []; page.on("pageerror", e => errors.push(e.message)); page.on("request", r => { if (!r.url().startsWith(t.h.baseUrl.origin)) external.push(r.url()); });
    const region = await open(page, t); await region.getByRole("button", { name: "同步 Agent 邮箱", exact: true }).click();
    await region.getByRole("status").filter({ hasText: "本批保存 1 封" }).waitFor(); assert.equal(t.opens.length, 1);
    await region.getByRole("button", { name: "attachments", exact: true }).click(); const detail = region.getByRole("article", { name: "Agent 邮件详情", exact: true });
    await detail.getByText("未知服务 · 发件身份未验证", { exact: true }).waitFor(); assert.match(await detail.getByTestId("mail-body").textContent(), /纯文本/);
    await detail.getByRole("button", { name: "安全 HTML", exact: true }).click(); const frame = page.frameLocator('iframe[title="安全邮件正文"]');
    await frame.getByText("HTML", { exact: true }).waitFor(); assert.equal(await frame.locator("script, img, a[href], iframe, form").count(), 0);
    const downloadButton = detail.getByRole("button", { name: "下载 part-0.bin", exact: true });
    // Settle the out-of-viewport target before clicking beside the sandbox iframe (Chrome compositor hit-test boundary).
    await downloadButton.scrollIntoViewIfNeeded(); await downloadButton.hover();
    const event = page.waitForEvent("download"); await downloadButton.click();
    const download = await event, target = path.join(t.h.directory, "agent-inbox-attachment.bin"); await download.saveAs(target); assert.deepEqual(await readFile(target), Buffer.from(ATTACHMENT));
    await page.getByRole("combobox", { name: "权限", exact: true }).selectOption("agent-inbox"); await page.getByLabel("名称", { exact: true }).fill("Agent receive API");
    await page.getByRole("button", { name: "创建 Key", exact: true }).click(); const token = await page.getByTestId("new-key").textContent();
    expect(await t.messages("", { token })); expect(await t.h.request("/api/v1/agent-tasks", { token }), 403);
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(t.h.directory, "agent-inbox-mobile.png"), fullPage: true });
    await page.reload(); await page.getByRole("navigation").getByRole("button", { name: "Agent 邮箱", exact: true }).click();
    await page.getByRole("region", { name: "Agent 邮箱", exact: true }).getByRole("button", { name: "普通邮箱", exact: true }).click();
    await region.getByRole("button", { name: "attachments", exact: true }).waitFor(); assert.equal(t.opens.length, 1, "cache reads never connect automatically");
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_messages").first("n"), 0);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0); assert.deepEqual(errors, []); assert.deepEqual(external, []);
  } catch (error) { if (page) console.error(await page.locator("body").ariaSnapshot()); throw error; }
  finally { await browser?.close(); await t.close(); }
});

test("Chrome: unknown or malformed Agent receive responses retain one original key/body across tabs and reconcile before any retry", { timeout: 90000 }, async () => {
  const t = await agentInboxFixture({ browser: true }); let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true }); const page = await browser.newPage(); page.setDefaultTimeout(10000);
    const region = await open(page, t), keys = [], bodies = []; let valid = false, reads = 0;
    await page.route(`**${t.base}/sync`, async route => {
      keys.push(route.request().headers()["idempotency-key"]); bodies.push(route.request().postData());
      if (keys.length === 1) return route.abort("failed"); await route.fetch(); return route.fulfill({ status: 200, json: {} });
    });
    await page.route(`**${t.base}/sync-requests/*`, route => { reads++; return valid || reads === 1 ? route.continue() : route.fulfill({ status: 200, json: {} }); });
    await region.getByRole("button", { name: "同步 Agent 邮箱", exact: true }).click(); const recover = region.getByRole("button", { name: "核对原 Agent 同步", exact: true }); await recover.waitFor();
    const accounts = page.getByRole("region", { name: "Agent 邮箱", exact: true });
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some(row => row.textContent === "移除 Agent 邮箱" && row.disabled));
    assert.equal(await accounts.getByRole("button", { name: "移除 Agent 邮箱", exact: true }).isDisabled(), true);
    await page.getByRole("navigation").getByRole("button", { name: "Agent 服务", exact: true }).click();
    await page.getByRole("navigation").getByRole("button", { name: "Agent 邮箱", exact: true }).click(); await recover.click();
    await region.getByRole("alert").filter({ hasText: "响应不匹配" }).waitFor(); await recover.click();
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some(row => row.textContent === "核对原 Agent 同步" && !row.disabled));
    assert.equal(keys.length, 2); assert.equal(new Set(keys).size, 1); assert.equal(new Set(bodies).size, 1); assert.equal(t.opens.length, 1);
    valid = true; await recover.click(); await region.getByRole("status").filter({ hasText: "本批保存 2 封" }).waitFor(); assert.equal(keys.length, 2); assert.equal(t.opens.length, 1);
    const bob = await t.h.register("agent-inbox-web-bob"); await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await page.getByLabel("用户名", { exact: true }).fill(bob.username); await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByRole("navigation").getByRole("button", { name: "Agent 邮箱", exact: true }).click(); await accounts.getByText("暂无 Agent 邮箱", { exact: true }).waitFor();
    assert.equal(await region.count(), 0); assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  } finally { await browser?.close(); await t.close(); }
});

test("Chrome: task detail shows actual header-linked replies without claiming sender authentication or delivery completion", { timeout: 90000 }, async () => {
  const t = await agentAssociationFixture({ browser: true }); let browser;
  try {
    const task = await t.task(); t.scenario({ messages: new Map([[1, agentReply(task.messageId, { subject: "任务回信验收" })]]), uidNext: 2 }); expect(await t.receive());
    browser = await chromium.launch({ executablePath, headless: true }); const page = await browser.newPage(); page.setDefaultTimeout(10000); await open(page, t);
    await page.getByRole("navigation").getByRole("button", { name: "Agent 任务", exact: true }).click(); const tasks = page.getByRole("region", { name: "Agent 任务", exact: true });
    await tasks.getByRole("button", { name: "回信关联合成任务", exact: true }).click(); const detail = tasks.getByRole("article", { name: "Agent 任务详情", exact: true });
    await detail.getByRole("status").filter({ hasText: "等待派发" }).waitFor(); const replies = detail.getByRole("region", { name: "任务关联回信", exact: true });
    await replies.getByRole("button", { name: "任务回信验收", exact: true }).click(); await replies.getByText("已关联任务 · 发件身份未验证", { exact: true }).waitFor();
    assert.equal(t.opens.length, 1); assert.equal(await t.h.db.prepare("SELECT state FROM agent_outgoing_messages WHERE id=?").bind(task.outgoingId).first("state"), "queued");
  } finally { await browser?.close(); await t.close(); }
});
