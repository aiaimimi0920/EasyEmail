import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { normalAccessFixture } from "./normal-access-fixture.mjs";
import { PASSWORD } from "./runtime-harness.mjs";

const button = (p, name) => p.getByRole("button", { name, exact: true });
const combo = (p, name) => p.getByRole("combobox", { name, exact: true });
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
async function evidence(page, t, filename) {
  await page.getByTestId("new-key").evaluate(element => { element.textContent = "[redacted]"; }).catch(() => {});
  await page.screenshot({ path: path.join(t.h.directory, filename), fullPage: true });
}

test("Chrome: normal platform read/star/archive/trash/restore and mixed-source filters never issue remote mutations", { timeout: 120000 }, async () => {
  const t = await normalAccessFixture({ browser: true }); let browser, page;
  try {
    await t.receive(); let inbox; ({ browser, page, inbox } = await open(t));
    const errors = [], external = []; page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (!request.url().startsWith(t.h.baseUrl.origin)) external.push(request.url()); });
    let actions = inbox.getByRole("region", { name: "普通邮件整理", exact: true });
    await button(actions, "标为已读").click(); await button(actions, "标为未读").waitFor();
    await button(actions, "加星标").click(); await button(actions, "取消星标").waitFor();
    await combo(inbox, "阅读状态").selectOption("true"); await combo(inbox, "星标筛选").selectOption("true"); await button(inbox, "搜索邮件").click();
    await inbox.getByRole("status").filter({ hasText: "已加载 1 封" }).waitFor(); await button(inbox, "收件验收").click();
    await button(actions, "归档").click(); await inbox.getByRole("status").filter({ hasText: "已加载 0 封" }).waitFor();
    await combo(inbox, "文件夹").selectOption("archive"); await button(inbox, "搜索邮件").click(); await button(inbox, "收件验收").click();
    page.once("dialog", dialog => dialog.dismiss()); await button(actions, "移到平台回收站").click();
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_message_state WHERE trashed_at IS NOT NULL").first("n"), 0);
    page.once("dialog", dialog => dialog.accept()); await button(actions, "移到平台回收站").click();
    await inbox.getByRole("status").filter({ hasText: "已加载 0 封" }).waitFor();
    await combo(inbox, "文件夹").selectOption("trash"); await button(inbox, "搜索邮件").click(); await button(inbox, "收件验收").click();
    await button(actions, "恢复平台邮件").click(); await inbox.getByRole("status").filter({ hasText: "已加载 0 封" }).waitFor();
    await combo(inbox, "文件夹").selectOption("archive"); await button(inbox, "搜索邮件").click(); await button(inbox, "收件验收").click();
    await button(actions, "移回收件箱").click(); await inbox.getByRole("status").filter({ hasText: "已加载 0 封" }).waitFor();
    await combo(inbox, "文件夹").selectOption("inbox"); await button(inbox, "搜索邮件").click(); await button(inbox, "收件验收").waitFor();
    assert.equal(t.opens.length, 1); assert.equal(t.calls.some(line => /STORE|EXPUNGE|COPY|MOVE/.test(line)), false);
    assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await evidence(page, t, "normal-organization-mobile.png"); console.log(`Normal organization browser evidence: ${t.h.directory}`);
  } catch (error) { if (page) await evidence(page, t, "normal-organization-failure.png"); throw error; }
  finally { await browser?.close(); await t.close(); }
});

test("Chrome: lost normal organization response retains exact body/key across navigation and never overwrites a later edit", { timeout: 90000 }, async () => {
  const t = await normalAccessFixture({ browser: true }); let browser, page;
  try {
    await t.receive(); let inbox; ({ browser, page, inbox } = await open(t));
    const attempts = []; let lose = true;
    await page.route(`**/api/v1/normal-accounts/${t.id}/messages/organize`, async route => {
      attempts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() });
      const response = await route.fetch();
      if (lose) { lose = false; await response.dispose(); return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "normal_organization_storage_failed" } }) }); }
      await route.fulfill({ response });
    });
    await button(inbox, "标为已读").click(); await page.getByRole("alert").filter({ hasText: "普通邮件整理结果未确认" }).waitFor();
    const id = attempts[0].body.messageIds[0];
    assert.equal((await t.h.request(`${t.base}/messages/organize`, { method: "POST", cookie: t.alice.cookie,
      headers: { "idempotency-key": crypto.randomUUID() }, body: { messageIds: [id], isRead: false } })).status, 200);
    await page.getByRole("navigation").getByRole("button", { name: "普通邮箱", exact: true }).click();
    const normal = page.getByRole("region", { name: "普通邮箱", exact: true });
    await button(normal, "普通邮箱").waitFor(); assert.equal(await button(normal, "普通邮箱").isDisabled(), true);
    await button(page, "重试原普通整理").click(); await page.getByRole("status").filter({ hasText: "已核对原操作" }).waitFor();
    assert.equal(attempts.length, 2); assert.deepEqual(attempts[0], attempts[1]);
    assert.equal((await t.message(id)).body.message.platformState.isRead, false);
    assert.equal(await button(normal, "普通邮箱").isEnabled(), true);
    await button(normal, "普通邮箱").click(); await combo(normal, "普通平台文件夹").selectOption("all");
    await button(normal, "收件验收").first().click(); await button(normal, "加星标").click();
    await page.getByText("已整理 1 封普通邮件", { exact: true }).waitFor();
    await page.getByLabel("名称", { exact: true }).fill("normal-platform-key"); await combo(page, "权限").selectOption("normal-trash");
    await button(page, "创建 Key").click(); const token = await page.getByTestId("new-key").textContent();
    const scopes = JSON.parse((await t.h.db.prepare("SELECT scopes FROM api_keys WHERE name='normal-platform-key'").first()).scopes);
    assert.deepEqual(scopes, ["mail-accounts:read", "messages:read", "messages:write", "messages:delete"]);
    const independent = await t.h.request(`${t.base}/messages/organize`, { method: "POST", token, origin: null,
      headers: { "idempotency-key": crypto.randomUUID() }, body: { messageIds: [id], starred: true } });
    assert.equal(independent.status, 200, independent.text);
    assert.equal((await t.h.request(`${t.base}/sync`, { method: "POST", token, origin: null, body: {} })).status, 403);
    await button(page, "隐藏").click();
    assert.equal(t.opens.length, 1); assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    await evidence(page, t, "normal-organization-original-key.png");
  } catch (error) { if (page) await evidence(page, t, "normal-organization-original-key-failure.png"); throw error; }
  finally { await browser?.close(); await t.close(); }
});

test("Chrome: read-only reconciliation of a lost normal organization response does not replay POST", { timeout: 90000 }, async () => {
  const t = await normalAccessFixture({ browser: true }); let browser, page;
  try {
    await t.receive(); let inbox; ({ browser, page, inbox } = await open(t)); let writes = 0, reads = 0;
    page.on("request", request => { if (request.url().includes("/organization-operations/")) reads++; });
    await page.route(`**/api/v1/normal-accounts/${t.id}/messages/organize`, async route => {
      writes++; const response = await route.fetch(); assert.equal(response.status(), 200); await response.dispose();
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "normal_organization_storage_failed" } }) });
    });
    await button(inbox, "加星标").click(); await button(page, "核对原普通整理").waitFor();
    await button(page, "核对原普通整理").click(); await page.getByRole("status").filter({ hasText: "已核对原操作" }).waitFor();
    assert.equal(writes, 1); assert.equal(reads, 1); assert.equal(t.opens.length, 1);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_organization_operations").first("n"), 1);
  } finally { await browser?.close(); await t.close(); }
});
