import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { normalAccessFixture } from "./normal-access-fixture.mjs";
import { putLabel, labelBody, expect } from "./labels-fixture.mjs";
import { putFolder, folderBody } from "./folders-fixture.mjs";
import { PASSWORD } from "./runtime-harness.mjs";

const button = (p, name) => p.getByRole("button", { name, exact: true });
const combo = (p, name) => p.getByRole("combobox", { name, exact: true });
async function fixture() {
  const t = await normalAccessFixture({ browser: true }); await t.receive(); const label = crypto.randomUUID(), folder = crypto.randomUUID();
  expect(await putLabel(t.h, t.alice, label, labelBody("待处理")), 201); expect(await putFolder(t.h, t.alice, folder, folderBody("工作")), 201);
  return { ...t, label, folder };
}
async function open(t) {
  const browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); page.setDefaultTimeout(10000);
  await page.goto(t.h.baseUrl.href); await page.getByLabel("用户名", { exact: true }).fill(t.alice.username);
  await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await button(page, "登录").click();
  await page.getByRole("navigation").getByRole("button", { name: "聚合收件箱", exact: true }).click();
  const inbox = page.getByRole("region", { name: "聚合邮件", exact: true });
  await inbox.getByRole("status").filter({ hasText: "已加载 2 封" }).waitFor();
  await button(inbox, "收件验收").first().click(); return { browser, page, inbox };
}

test("Chrome: ordinary labels, shared filters and custom folder navigation use the same private workspace", { timeout: 120000 }, async () => {
  const t = await fixture(); let browser, page;
  try {
    let inbox; ({ browser, page, inbox } = await open(t)); const errors = [], external = [];
    page.on("pageerror", error => errors.push(error.message)); page.on("request", request => { if (!request.url().startsWith(t.h.baseUrl.origin)) external.push(request.url()); });
    let labels = inbox.getByRole("region", { name: "邮件标签", exact: true });
    await combo(labels, "添加邮件标签").selectOption(t.label); await button(labels, "添加到此邮件").click();
    await button(labels, "移除标签 待处理").waitFor();
    const placement = inbox.getByRole("region", { name: "邮件文件夹", exact: true });
    await combo(placement, "移动到文件夹").selectOption(t.folder); await button(placement, "移动此邮件").click();
    await placement.getByText("当前位置：工作", { exact: true }).waitFor();
    await inbox.getByRole("status").filter({ hasText: "已加载 1 封" }).waitFor();
    await combo(inbox, "标签筛选").selectOption(t.label); await combo(inbox, "自定义文件夹筛选").selectOption(t.folder);
    await button(inbox, "搜索邮件").click(); await button(inbox, "收件验收").click();
    await button(labels, "移除标签 待处理").waitFor();
    await page.getByRole("navigation").getByRole("button", { name: "普通邮箱", exact: true }).click();
    const normal = page.getByRole("region", { name: "普通邮箱", exact: true }); await button(normal, "普通邮箱").click();
    await combo(normal, "普通平台文件夹").selectOption(`custom:${t.folder}`); await button(normal, "收件验收").click();
    labels = normal.getByRole("region", { name: "邮件标签", exact: true }); await button(labels, "移除标签 待处理").click();
    await button(normal, "收件验收").click(); await normal.getByRole("region", { name: "邮件标签", exact: true }).getByText("邮件标签", { exact: true }).waitFor();
    const folder = normal.getByRole("region", { name: "邮件文件夹", exact: true });
    await combo(folder, "移动到文件夹").selectOption(""); await button(folder, "移动此邮件").click(); await normal.getByText("暂无缓存邮件", { exact: true }).waitFor();
    await combo(normal, "普通平台文件夹").selectOption("inbox"); await button(normal, "收件验收").first().waitFor();
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(t.h.directory, "normal-taxonomy-mobile.png"), fullPage: true });
    assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(t.opens.length, 1);
    assert.equal(t.calls.some(line => /STORE|EXPUNGE|COPY|MOVE/.test(line)), false);
    console.log(`Normal taxonomy browser evidence: ${t.h.directory}`);
  } catch (error) { if (page) await page.screenshot({ path: path.join(t.h.directory, "normal-taxonomy-failure.png"), fullPage: true }); throw error; }
  finally { await browser?.close(); await t.close(); }
});

test("Chrome: unknown taxonomy keeps the exact key and targets across navigation; the new Key preset cannot configure or delete", { timeout: 120000 }, async () => {
  const t = await fixture(); let browser, page;
  try {
    let inbox; ({ browser, page, inbox } = await open(t)); const attempts = []; let lose = true;
    await page.route(`**/api/v1/normal-accounts/${t.id}/messages/organize`, async route => {
      attempts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() }); const response = await route.fetch();
      if (lose) { lose = false; await response.dispose(); return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "normal_organization_storage_failed" } }) }); }
      await route.fulfill({ response });
    });
    const placement = inbox.getByRole("region", { name: "邮件文件夹", exact: true });
    await combo(placement, "移动到文件夹").selectOption(t.folder); await button(placement, "移动此邮件").click();
    await page.getByRole("alert").filter({ hasText: "普通邮件整理结果未确认" }).waitFor();
    assert.equal(await combo(placement, "移动到文件夹").isDisabled(), true);
    const id = attempts[0].body.messageIds[0];
    expect(await t.h.request(`${t.base}/messages/organize`, { method: "POST", cookie: t.alice.cookie, headers: { "idempotency-key": crypto.randomUUID() }, body: { messageIds: [id], folderId: null } }));
    await page.getByRole("navigation").getByRole("button", { name: "普通邮箱", exact: true }).click();
    const normal = page.getByRole("region", { name: "普通邮箱", exact: true }); await button(normal, "普通邮箱").waitFor();
    assert.equal(await button(normal, "普通邮箱").isDisabled(), true);
    await button(page, "重试原普通整理").click(); await page.getByRole("status").filter({ hasText: "已核对原操作" }).waitFor();
    assert.deepEqual(attempts[0], attempts[1]); assert.equal(attempts.length, 2);
    assert.equal(expect(await t.h.request(`${t.base}/messages/${id}/folder`, { cookie: t.alice.cookie })).folder, null);
    await page.getByLabel("名称", { exact: true }).fill("normal-taxonomy-key"); await combo(page, "权限").selectOption("normal-taxonomy");
    await button(page, "创建 Key").click(); const token = await page.getByTestId("new-key").textContent();
    const scopes = JSON.parse((await t.h.db.prepare("SELECT scopes FROM api_keys WHERE name='normal-taxonomy-key'").first()).scopes);
    assert.deepEqual(scopes, ["mail-accounts:read", "messages:read", "messages:write", "labels:read", "folders:read"]);
    expect(await t.h.request(`${t.base}/messages/organize`, { method: "POST", token, origin: null, headers: { "idempotency-key": crypto.randomUUID() }, body: { messageIds: [id], addLabelIds: [t.label], folderId: t.folder } }));
    assert.equal((await t.h.request(`${t.base}/sync`, { method: "POST", token, origin: null, body: {} })).status, 403);
    assert.equal((await t.h.request(`/api/v1/folders/${t.folder}`, { method: "DELETE", token, origin: null, body: { expectedRevision: 1 } })).status, 403);
    await button(page, "隐藏").click(); assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.equal(t.opens.length, 1);
  } finally { await browser?.close(); await t.close(); }
});
