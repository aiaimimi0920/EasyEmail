import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { normalAttachmentsFixture } from "./normal-attachments-fixture.mjs";
import { assetBytes, assetRef } from "./outbox-fixture.mjs";
import { mailInput } from "./normal-send-fixture.mjs";
import { PASSWORD } from "./runtime-harness.mjs";

async function open(t) {
  const browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); page.setDefaultTimeout(10000);
  await page.goto(t.h.baseUrl.href); await page.getByLabel("用户名", { exact: true }).fill(t.alice.username);
  await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("navigation", { name: "邮件工作台" }).getByRole("button", { name: "普通邮箱", exact: true }).click();
  const region = page.getByRole("region", { name: "普通邮箱", exact: true }); await region.getByRole("button", { name: "普通发信邮箱", exact: true }).click();
  const send = page.getByRole("region", { name: "普通邮箱发信", exact: true }); await send.getByRole("button", { name: "保存普通邮箱云端草稿", exact: true }).waitFor();
  return { page, browser, region, send, drafts: send.getByRole("region", { name: "普通邮箱云端草稿", exact: true }) };
}
test("Chrome ordinary upload loss recovery locks navigation and preserves refs through cloud draft and lost-send GET recovery", { timeout: 90000 }, async () => {
  const t = await normalAttachmentsFixture(true); let ui;
  try {
    await t.configure(); ui = await open(t); const { page, send, drafts, region } = ui, errors = [], reserves = [], posts = [], gets = [];
    page.on("pageerror", error => errors.push(error.message));
    await send.getByLabel("收件地址", { exact: true }).fill(mailInput.to); await send.getByLabel("普通邮件主题", { exact: true }).fill("普通附件浏览器");
    await send.getByLabel("普通邮件正文", { exact: true }).fill(mailInput.text);
    await page.route("**/api/v1/outbox-attachments", route => { if (route.request().method() === "POST") reserves.push(route.request().headers()["idempotency-key"]); return route.continue(); });
    await page.route("**/api/v1/outbox-attachments/*/content", async route => { await route.fetch(); await route.abort("failed"); });
    await send.getByLabel("添加发送附件", { exact: true }).setInputFiles({ name: "浏览器附件.bin", mimeType: "application/octet-stream", buffer: Buffer.from(assetBytes) });
    await send.getByRole("status").filter({ hasText: "上传待确认" }).waitFor();
    assert.equal(await send.getByRole("button", { name: "保存普通邮箱云端草稿", exact: true }).isDisabled(), true);
    assert.equal(await send.getByRole("button", { name: "发送普通邮件", exact: true }).isDisabled(), true);
    assert.equal(await send.getByRole("button", { name: "新建普通邮件", exact: true }).isDisabled(), true);
    assert.equal(await region.getByRole("button", { name: "添加普通邮箱", exact: true }).isDisabled(), true);
    await send.getByRole("button", { name: "核对原上传", exact: true }).click(); await send.getByText("浏览器附件.bin", { exact: true }).waitFor();
    assert.equal(new Set(reserves).size, 1);
    await send.getByRole("button", { name: "保存普通邮箱云端草稿", exact: true }).click(); await send.getByRole("status").filter({ hasText: "已保存到云端 · 版本 1" }).waitFor();
    assert.equal(await send.getByRole("button", { name: "发送普通邮件", exact: true }).isEnabled(), true);
    await send.getByRole("button", { name: "新建普通邮件", exact: true }).click(); await drafts.getByRole("button", { name: "普通附件浏览器", exact: true }).click();
    await send.getByText("浏览器附件.bin", { exact: true }).waitFor();
    await page.route(`**/api/v1/normal-accounts/${t.id}/send`, async route => { posts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() }); await route.fetch(); await route.abort("failed"); });
    await page.route(`**/api/v1/normal-accounts/${t.id}/outgoing?requestKey=*`, route => { gets.push(route.request().url()); return route.continue(); });
    await send.getByRole("button", { name: "发送普通邮件", exact: true }).click(); await send.getByRole("button", { name: "核对原普通邮件发送", exact: true }).waitFor();
    await send.getByRole("button", { name: "核对原普通邮件发送", exact: true }).click(); await send.getByRole("status").filter({ hasText: "此普通草稿已提交发送" }).waitFor();
    assert.equal(posts.length, 1); assert.equal(posts[0].body.attachments.length, 1); assert.deepEqual(Object.keys(posts[0].body.attachments[0]).sort(), ["id", "version"]);
    assert.equal(gets.length, 1); assert.ok(gets[0].includes(posts[0].key)); assert.equal(t.messages.length, 1);
    await page.getByRole("combobox", { name: "权限", exact: true }).selectOption("normal-outbox"); await page.getByRole("textbox", { name: "名称", exact: true }).fill("普通附件");
    await page.getByRole("button", { name: "创建 Key", exact: true }).click(); await page.getByTestId("new-key").waitFor();
    const key = await page.getByTestId("new-key").textContent(); assert.equal((await t.h.request("/api/v1/outbox-attachments", { token: key, origin: null })).status, 200);
    assert.deepEqual(errors, []); assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } catch (error) { if (ui) console.error(await ui.page.locator("body").ariaSnapshot()); throw error; }
  finally { await ui?.browser.close(); await t.close(); }
});

test("Chrome expired ordinary draft attachments stay visible and block send until explicit removal and re-save", { timeout: 90000 }, async () => {
  const t = await normalAttachmentsFixture(true); let ui;
  try {
    await t.configure(); const asset = await t.upload(), id = crypto.randomUUID(); assert.equal((await t.save(id, [assetRef(asset)])).status, 201);
    await t.h.db.prepare("UPDATE outbox_assets SET expires_at=1 WHERE id=?").bind(asset.id).run(); ui = await open(t);
    await ui.drafts.getByRole("button", { name: mailInput.subject, exact: true }).click();
    await ui.send.getByRole("status").filter({ hasText: "附件不可用" }).waitFor();
    assert.equal(await ui.send.getByRole("button", { name: "发送普通邮件", exact: true }).isDisabled(), true);
    await ui.send.getByRole("button", { name: "移除引用", exact: true }).click();
    assert.equal(await ui.send.getByRole("button", { name: "发送普通邮件", exact: true }).isDisabled(), true);
    await ui.send.getByRole("button", { name: "保存普通邮箱云端草稿", exact: true }).click(); await ui.send.getByRole("status").filter({ hasText: "已保存到云端 · 版本 2" }).waitFor();
    assert.equal(await ui.send.getByRole("button", { name: "发送普通邮件", exact: true }).isEnabled(), true); assert.equal(t.messages.length, 0);
  } catch (error) { if (ui) console.error(await ui.page.locator("body").ariaSnapshot()); throw error; }
  finally { await ui?.browser.close(); await t.close(); }
});
