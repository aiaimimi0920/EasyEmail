import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { PASSWORD } from "./runtime-harness.mjs";
import { queueFixture } from "./queue-fixture.mjs";
import { sendCalls } from "./send-fixture.mjs";
import path from "node:path";

const button = (p, name) => p.getByRole("button", { name, exact: true });
const field = (p, name) => p.getByLabel(name, { exact: true });
test("Chrome: scheduled intent, lost enqueue response, cross-page recovery and explicit durable cancellation", { timeout: 90000 }, async () => {
  const t = await queueFixture({ browser: true }); let browser, p;
  try {
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    p = await browser.newPage(); p.setDefaultTimeout(10000); const errors = [], external = [], writes = [];
    p.on("pageerror", e => errors.push(e.message)); p.on("request", r => { if (!r.url().startsWith(t.h.baseUrl.origin)) external.push(r.url()); });
    await p.goto(t.h.baseUrl.href); await field(p, "用户名").fill(t.alice.username); await field(p, "密码").fill(PASSWORD); await button(p, "登录").click();
    await button(p, "写信与发送记录").click(); await field(p, "发件邮箱").selectOption(t.box.id);
    await field(p, "收件地址").fill("recipient@example.test"); await field(p, "邮件主题").fill("定时验收"); await field(p, "纯文本正文").fill("页面关闭后意图仍保留");
    await field(p, "发送方式").selectOption("scheduled");
    const future = new Date(Date.now() + 3600000), local = new Date(future.getTime() - future.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    await field(p, "计划发送时间").fill(local);
    await field(p, "我已核对收件地址和内容，确认提交一次发送").check();
    let lost = false;
    await p.route("**/api/v1/mailboxes/*/send-jobs", async route => {
      writes.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
      if (!lost) { lost = true; await route.fetch(); await route.abort("connectionfailed"); } else await route.continue();
    });
    await button(p, "确认定时发送").click(); await button(p, "检查本次发送结果").waitFor();
    await button(p, "邮箱管理").click(); await button(p, "写信与发送记录").click();
    assert.equal(await field(p, "计划发送时间").isDisabled(), true);
    await button(p, "检查本次发送结果").click();
    await p.getByRole("region", { name: "写信", exact: true }).getByRole("status").filter({ hasText: "已加入发送队列" }).waitFor();
    assert.deepEqual(writes[0], writes[1]); assert.equal(sendCalls(t.f).length, 0);
    const row = await t.h.db.prepare("SELECT * FROM send_jobs").first();
    assert.equal(row.scheduled_at, Math.floor(new Date(local).getTime() / 1000));
    await p.reload(); await button(p, "写信与发送记录").click();
    const region = p.getByRole("region", { name: "发送队列", exact: true });
    await region.getByRole("button", { name: "定时验收", exact: true }).click();
    const detail = p.getByRole("article", { name: "任务详情", exact: true });
    await detail.getByText("页面关闭后意图仍保留", { exact: true }).waitFor();
    const actions = []; let calls = 0;
    await p.route("**/api/v1/send-jobs/*/cancel", async route => {
      actions.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() }); calls++;
      if (calls === 1) { await route.fetch(); await route.abort("connectionfailed"); }
      else if (calls === 2) await route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: { code: "rate_limited" } }) });
      else await route.continue();
    });
    p.once("dialog", dialog => dialog.accept()); await detail.getByRole("button", { name: "取消排队", exact: true }).click();
    await button(p, "核对原队列操作").waitFor();
    await button(p, "邮箱管理").click(); await button(p, "写信与发送记录").click();
    await button(p, "核对原队列操作").click(); await region.getByRole("alert").filter({ hasText: "操作过于频繁" }).waitFor();
    await button(p, "核对原队列操作").click();
    await detail.getByText("已取消", { exact: true }).waitFor();
    assert.deepEqual(actions, [actions[0], actions[0], actions[0]]);
    await t.tick(); assert.equal(sendCalls(t.f).length, 0);
    assert.equal(await p.evaluate(() => localStorage.length + sessionStorage.length), 0);
    await p.setViewportSize({ width: 390, height: 844 }); assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await p.screenshot({ path: path.join(t.h.directory, "queue-mobile.png"), fullPage: true });
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
  } catch (error) { if (p) console.error(await p.locator("body").ariaSnapshot()); throw error; }
  finally { await browser?.close(); await t.close(); }
});
