import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { PASSWORD } from "./runtime-harness.mjs";
import { normalSendFixture, mailInput, smtpInput } from "./normal-send-fixture.mjs";

async function open(t) {
  const browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); page.setDefaultTimeout(10000);
  await page.goto(t.h.baseUrl.href); await page.getByLabel("用户名", { exact: true }).fill(t.alice.username);
  await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("navigation", { name: "邮件工作台" }).getByRole("button", { name: "普通邮箱", exact: true }).click();
  const region = page.getByRole("region", { name: "普通邮箱", exact: true }); await region.getByRole("button", { name: "普通发信邮箱", exact: true }).click();
  const send = page.getByRole("region", { name: "普通邮箱发信", exact: true });
  await send.getByRole("button", { name: "保存普通邮箱云端草稿", exact: true }).waitFor({ state: "visible" });
  return { page, browser, region, send, drafts: send.getByRole("region", { name: "普通邮箱云端草稿", exact: true }) };
}
test("Chrome: ordinary cloud draft lost-save recovery reuses its identity and lost-send recovery only reads the original receipt", { timeout: 90000 }, async () => {
  const t = await normalSendFixture(true); let ui;
  try {
    await t.configure(); ui = await open(t); const { page, send, region, drafts } = ui, errors = [], puts = [], posts = [], gets = [];
    page.on("pageerror", error => errors.push(error.message));
    await send.getByLabel("收件地址", { exact: true }).fill(mailInput.to); await send.getByLabel("普通邮件主题", { exact: true }).fill("普通云草稿浏览器");
    await send.getByLabel("普通邮件正文", { exact: true }).fill("丢失响应仍使用原草稿与发送键");
    assert.equal(await region.getByRole("button", { name: "添加普通邮箱", exact: true }).isDisabled(), true);
    let firstSave = true;
    await page.route(`**/api/v1/normal-accounts/${t.id}/drafts/*`, async route => {
      if (route.request().method() !== "PUT") return route.continue(); puts.push({ path: route.request().url(), body: route.request().postDataJSON() });
      if (firstSave) { firstSave = false; await route.fetch(); return route.abort("failed"); } return route.continue();
    });
    await send.getByRole("button", { name: "保存普通邮箱云端草稿", exact: true }).click(); await send.getByRole("alert").waitFor();
    await send.getByRole("button", { name: "保存普通邮箱云端草稿", exact: true }).click();
    await send.getByRole("status").filter({ hasText: "已保存到云端 · 版本 1" }).waitFor();
    assert.equal(puts.length, 2); assert.deepEqual(puts[0], puts[1]); assert.equal(await region.getByRole("button", { name: "添加普通邮箱", exact: true }).isEnabled(), true);
    await send.getByRole("button", { name: "新建普通邮件", exact: true }).click();
    await drafts.getByRole("button", { name: "普通云草稿浏览器", exact: true }).click();
    await send.getByRole("status").filter({ hasText: "已保存到云端 · 版本 1" }).waitFor();
    assert.equal(await send.getByLabel("普通邮件正文", { exact: true }).inputValue(), "丢失响应仍使用原草稿与发送键");
    await page.route(`**/api/v1/normal-accounts/${t.id}/send`, async route => { posts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() }); await route.fetch(); await route.abort("failed"); });
    await page.route(`**/api/v1/normal-accounts/${t.id}/outgoing?requestKey=*`, route => { gets.push(route.request().url()); return route.continue(); });
    await send.getByRole("button", { name: "发送普通邮件", exact: true }).click(); await send.getByRole("button", { name: "核对原普通邮件发送", exact: true }).waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent === "添加普通邮箱" && button.disabled));
    assert.equal(await region.getByRole("button", { name: "添加普通邮箱", exact: true }).isDisabled(), true);
    assert.equal(await send.getByRole("button", { name: "保存普通邮箱云端草稿", exact: true }).isDisabled(), true);
    assert.equal(await drafts.getByRole("button", { name: "删除草稿", exact: true }).isDisabled(), true);
    await page.getByRole("navigation").getByRole("button", { name: "联系人", exact: true }).click();
    await page.getByRole("navigation").getByRole("button", { name: "普通邮箱", exact: true }).click();
    await send.getByRole("button", { name: "核对原普通邮件发送", exact: true }).click();
    await send.getByRole("status").filter({ hasText: "此普通草稿已提交发送" }).waitFor();
    assert.equal(posts.length, 1); assert.ok(posts[0].body.draftId); assert.equal(posts[0].body.draftRevision, 1);
    assert.equal(gets.length, 1); assert.ok(gets[0].includes(posts[0].key)); assert.equal(t.messages.length, 1);
    const stored = await t.h.db.prepare("SELECT state,revision FROM drafts WHERE id=?").bind(posts[0].body.draftId).first(); assert.deepEqual(stored, { state: "submitted", revision: 2 });
    assert.deepEqual(errors, []); assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } catch (error) { if (ui) console.error(await ui.page.locator("body").ariaSnapshot()); throw error; }
  finally { await ui?.browser.close(); await t.close(); }
});

test("Chrome: old ordinary draft requires explicit account-revision rebinding, then saves before SMTP send", { timeout: 90000 }, async () => {
  const t = await normalSendFixture(true); let ui;
  try {
    const id = crypto.randomUUID(), route = `${t.path}/drafts/${id}`;
    assert.equal((await t.h.request(route, { method: "PUT", cookie: t.alice.cookie,
      body: { expectedRevision: 0, accountRevision: 1, to: mailInput.to, subject: "旧版本草稿", text: "保留旧内容" } })).status, 201);
    await t.h.db.prepare("UPDATE normal_accounts SET revision=2 WHERE id=?").bind(t.id).run();
    await t.configure({ ...smtpInput, expectedRevision: 2 }); ui = await open(t); const { page, send, drafts } = ui;
    await drafts.getByRole("button", { name: "旧版本草稿", exact: true }).click();
    await send.getByRole("button", { name: "关联到当前账号版本", exact: true }).waitFor();
    assert.equal(await send.getByLabel("普通邮件正文", { exact: true }).inputValue(), "保留旧内容");
    assert.equal(await send.getByRole("button", { name: "发送普通邮件", exact: true }).isDisabled(), true);
    assert.equal(await send.getByRole("button", { name: "保存普通邮箱云端草稿", exact: true }).isDisabled(), true);
    page.once("dialog", dialog => dialog.dismiss()); await send.getByRole("button", { name: "关联到当前账号版本", exact: true }).click();
    assert.equal(await send.getByRole("button", { name: "发送普通邮件", exact: true }).isDisabled(), true);
    page.once("dialog", dialog => dialog.accept()); await send.getByRole("button", { name: "关联到当前账号版本", exact: true }).click();
    assert.equal(await send.getByRole("button", { name: "发送普通邮件", exact: true }).isDisabled(), true);
    await send.getByRole("button", { name: "保存普通邮箱云端草稿", exact: true }).click(); await send.getByRole("status").filter({ hasText: "已保存到云端 · 版本 2" }).waitFor();
    await send.getByRole("button", { name: "发送普通邮件", exact: true }).click(); await send.getByRole("status").filter({ hasText: "服务器已接受" }).waitFor();
    assert.equal(t.messages.length, 1); const row = await t.h.db.prepare("SELECT normal_account_revision,state,revision FROM drafts WHERE id=?").bind(id).first();
    assert.deepEqual(row, { normal_account_revision: 2, state: "submitted", revision: 3 });
    await page.getByRole("combobox", { name: "权限", exact: true }).selectOption("normal-drafts");
    await page.getByRole("textbox", { name: "名称", exact: true }).fill("普通草稿只写不发送"); await page.getByRole("button", { name: "创建 Key", exact: true }).click();
    await page.getByTestId("new-key").waitFor(); const token = await page.getByTestId("new-key").textContent();
    assert.equal((await t.h.request(route, { token })).status, 200);
    assert.equal((await t.send(mailInput, crypto.randomUUID(), { cookie: null, token })).status, 403);
  } catch (error) { if (ui) console.error(await ui.page.locator("body").ariaSnapshot()); throw error; }
  finally { await ui?.browser.close(); await t.close(); }
});
