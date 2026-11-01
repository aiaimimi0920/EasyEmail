import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { normalQueueFixture } from "./normal-queue-fixture.mjs";
import { PASSWORD } from "./runtime-harness.mjs";

async function open(t) {
  const browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); page.setDefaultTimeout(10000);
  await page.goto(t.h.baseUrl.href); await page.getByLabel("用户名", { exact: true }).fill(t.alice.username);
  await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("navigation", { name: "邮件工作台" }).getByRole("button", { name: "普通邮箱", exact: true }).click();
  const region = page.getByRole("region", { name: "普通邮箱", exact: true }); await region.getByRole("button", { name: "普通发信邮箱", exact: true }).click();
  const send = page.getByRole("region", { name: "普通邮箱发信", exact: true });
  await send.getByLabel("收件地址", { exact: true }).fill("receiver@example.test"); await send.getByLabel("普通邮件主题").fill("普通队列浏览器");
  await send.getByLabel("普通邮件正文").fill("持久普通邮箱任务");
  return { browser, page, region, send, jobs: send.getByRole("region", { name: "普通邮箱发送队列", exact: true }) };
}
test("Chrome ordinary lost enqueue uses only original-key GET; uncertain cancellation pins account navigation through repeated replay", { timeout: 90000 }, async () => {
  const t = await normalQueueFixture(true); let ui;
  try {
    await t.configure(); ui = await open(t); const { page, send, jobs, region } = ui, posts = [], gets = [], actions = [], errors = [];
    page.on("pageerror", error => errors.push(error.message)); await send.getByLabel("发送方式", { exact: true }).selectOption("queued");
    await send.getByRole("button", { name: "保存普通邮箱云端草稿", exact: true }).click();
    await send.getByRole("status").filter({ hasText: "已保存到云端 · 版本 1" }).waitFor();
    await page.route(`**${t.root}`, async route => { if (route.request().method() !== "POST") return route.continue(); posts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() }); await route.fetch(); await route.abort("failed"); });
    await page.route(`**${t.root}?requestKey=*`, route => { gets.push(route.request().url()); return route.continue(); });
    await send.getByRole("button", { name: "普通邮件加入队列", exact: true }).click();
    await send.getByRole("button", { name: "核对原普通邮件入队", exact: true }).click();
    await send.getByRole("status").filter({ hasText: "已加入发送队列" }).waitFor(); assert.equal(posts.length, 1); assert.equal(t.opens.length, 0);
    assert.equal(gets.length, 1); assert.equal(new URL(gets[0]).searchParams.get("requestKey"), posts[0].key);
    const draft = await t.h.db.prepare("SELECT state,outgoing_id FROM drafts").first(); assert.deepEqual(draft, { state: "submitted", outgoing_id: null });
    page.once("dialog", dialog => dialog.accept()); await send.getByRole("button", { name: "另起普通邮件", exact: true }).click();
    assert.equal(await send.getByLabel("发送方式").inputValue(), "direct");
    await jobs.getByRole("button", { name: "普通队列浏览器", exact: true }).click(); const detail = jobs.getByRole("article", { name: "任务详情", exact: true });
    await page.route(`**${t.root}/*/cancel`, async route => {
      actions.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() });
      if (actions.length === 1) { await route.fetch(); return route.abort("failed"); }
      if (actions.length === 2) return route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: { code: "rate_limited" } }) });
      return route.continue();
    });
    page.once("dialog", dialog => dialog.accept()); await detail.getByRole("button", { name: "取消排队", exact: true }).click();
    await detail.getByRole("button", { name: "核对原队列操作", exact: true }).waitFor();
    assert.equal(await region.getByRole("button", { name: "添加普通邮箱", exact: true }).isDisabled(), true);
    assert.equal(await send.getByRole("button", { name: "保存普通邮箱云端草稿", exact: true }).isDisabled(), true);
    await detail.getByRole("button", { name: "核对原队列操作", exact: true }).click(); await jobs.getByRole("alert").filter({ hasText: "操作过于频繁" }).waitFor();
    assert.equal(await region.getByRole("button", { name: "添加普通邮箱", exact: true }).isDisabled(), true);
    await detail.getByRole("button", { name: "核对原队列操作", exact: true }).click(); await detail.getByText("已取消", { exact: true }).waitFor();
    assert.deepEqual(actions, [actions[0], actions[0], actions[0]]); await t.tick(); assert.equal(t.opens.length, 0);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0); assert.deepEqual(errors, []);
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } catch (error) { if (ui) console.error(await ui.page.locator("body").ariaSnapshot()); throw error; }
  finally { await ui?.browser.close(); await t.close(); }
});
test("Chrome ordinary scheduled request freezes endpoint, timestamp, content and key across pre-commit loss and elapsed browser time", { timeout: 90000 }, async () => {
  const t = await normalQueueFixture(true); let ui;
  try {
    await t.configure(); ui = await open(t); const { page, send } = ui, posts = [], direct = [];
    await page.clock.install(); await send.getByLabel("发送方式").selectOption("scheduled");
    const future = new Date(Date.now() + 3600000), local = new Date(future.getTime() - future.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    await send.getByLabel("计划发送时间").fill(local);
    await page.route(`**${t.path}/send`, route => { direct.push(route.request().url()); return route.abort("failed"); });
    await page.route(`**${t.root}`, route => {
      if (route.request().method() !== "POST") return route.continue();
      posts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() });
      return posts.length === 1 ? route.abort("failed") : route.continue();
    });
    await send.getByRole("button", { name: "普通邮件定时发送", exact: true }).click();
    await page.clock.fastForward(7200000); await send.getByRole("button", { name: "核对原普通邮件入队", exact: true }).click();
    await send.getByRole("button", { name: "提交原普通邮件入队", exact: true }).click();
    await send.getByRole("status").filter({ hasText: "已加入发送队列" }).waitFor();
    assert.deepEqual(posts, [posts[0], posts[0]]); assert.equal(posts[0].body.scheduledAt, Math.floor(new Date(local).getTime() / 1000)); assert.deepEqual(direct, []);
    await t.tick(); assert.equal(t.opens.length, 0);
  } catch (error) { if (ui) console.error(await ui.page.locator("body").ariaSnapshot()); throw error; }
  finally { await ui?.browser.close(); await t.close(); }
});
