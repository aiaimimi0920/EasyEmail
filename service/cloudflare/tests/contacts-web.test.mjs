import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { PASSWORD } from "./runtime-harness.mjs";
import { contactsFixture, contactBody, saveContact, contactWrite, getContact, expect } from "./contacts-fixture.mjs";

const field = (p, name) => p.getByLabel(name, { exact: true });
const button = (p, name) => p.getByRole("button", { name, exact: true });

test("Chrome: private contact CRUD, conflicts, lost writes, original-key recovery, pagination and account isolation", { timeout: 120000 }, async () => {
  const f = await contactsFixture({}, true); const { h, alice, bob } = f; let browser, page;
  try {
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); page.setDefaultTimeout(10000);
    const errors = [], external = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (!request.url().startsWith(h.baseUrl.origin)) external.push(request.url()); });
    await page.goto(h.baseUrl.href); await field(page, "用户名").fill(alice.username); await field(page, "密码").fill(PASSWORD); await button(page, "登录").click();
    await button(page, "联系人").click(); await page.getByRole("status").filter({ hasText: "已加载 0 位联系人" }).waitFor();
    await field(page, "联系人姓名").fill("客户甲"); await field(page, "联系人邮箱").fill("PERSON@Example.Test");
    await field(page, "联系人备注").fill('<img src=x onerror="window.contactExecuted=true">');
    const writes = []; let lost = false;
    await page.route("**/api/v1/contacts", async route => {
      if (route.request().method() !== "POST") return route.continue();
      writes.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
      if (!lost) { lost = true; await route.fetch(); await route.abort("connectionfailed"); } else await route.continue();
    });
    await button(page, "新增或更新联系人").click(); await button(page, "核对并完成原联系人操作").waitFor();
    const key = await page.getByTestId("contact-operation-key").textContent(); assert.equal(await field(page, "联系人姓名").isDisabled(), true);
    const id = await h.db.prepare("SELECT id FROM contacts WHERE user_id=? AND email_address='person@example.test'").bind(alice.id).first("id");
    expect(await contactWrite(h, alice, "PATCH", id, { expectedVersion: 1, note: "另一设备的新备注" }));
    await button(page, "邮箱管理").click(); await button(page, "联系人").click(); assert.equal(await page.getByTestId("contact-operation-key").textContent(), key);
    await button(page, "核对并完成原联系人操作").click(); await button(page, "编辑联系人 客户甲").waitFor();
    assert.deepEqual(writes[0], writes[1]); assert.equal(expect(await getContact(h, alice, id)).contact.version, 2);
    assert.equal(expect(await getContact(h, alice, id)).contact.note, "另一设备的新备注"); await page.unroute("**/api/v1/contacts");
    await button(page, "编辑联系人 客户甲").click(); await field(page, "联系人姓名").fill("保留的冲突编辑");
    expect(await contactWrite(h, alice, "PATCH", id, { expectedVersion: 2, note: "最新备注" }));
    await button(page, "保存联系人修改").click(); await page.getByRole("alert").filter({ hasText: "联系人已变化" }).waitFor();
    assert.equal(await field(page, "联系人姓名").inputValue(), "保留的冲突编辑");
    await button(page, "取消编辑联系人").click(); await button(page, "刷新联系人").click();
    await page.getByText("最新备注", { exact: true }).waitFor(); await button(page, "编辑联系人 客户甲").click();
    await field(page, "联系人姓名").fill("客户甲修改"); lost = false; const patches = [];
    await page.route("**/api/v1/contacts/*", async route => {
      if (route.request().method() !== "PATCH") return route.continue();
      patches.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
      if (!lost) { lost = true; await route.fetch(); await route.abort("connectionfailed"); } else await route.continue();
    });
    await button(page, "保存联系人修改").click(); await button(page, "核对并完成原联系人操作").waitFor();
    expect(await contactWrite(h, alice, "PATCH", id, { expectedVersion: 4, note: "不应被回放覆盖" }));
    await button(page, "核对并完成原联系人操作").click(); await button(page, "编辑联系人 客户甲修改").waitFor(); assert.deepEqual(patches[0], patches[1]);
    assert.equal(expect(await getContact(h, alice, id)).contact.note, "不应被回放覆盖"); await page.unroute("**/api/v1/contacts/*");
    page.once("dialog", dialog => dialog.dismiss()); await button(page, "删除联系人 客户甲修改").click(); expect(await getContact(h, alice, id));
    lost = false; const deletions = [];
    await page.route("**/api/v1/contacts/*", async route => {
      if (route.request().method() !== "DELETE") return route.continue();
      deletions.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
      if (!lost) { lost = true; await route.fetch(); await route.abort("connectionfailed"); } else await route.continue();
    });
    page.once("dialog", dialog => dialog.accept()); await button(page, "删除联系人 客户甲修改").click(); await button(page, "核对并完成原联系人操作").waitFor();
    const replacement = expect(await saveContact(h, alice, contactBody("person@example.test", "同邮箱新联系人")), 201);
    await button(page, "核对并完成原联系人操作").click(); await button(page, "编辑联系人 同邮箱新联系人").waitFor();
    assert.deepEqual(deletions[0], deletions[1]); expect(await getContact(h, alice, replacement.operation.contactId)); await page.unroute("**/api/v1/contacts/*");
    await field(page, "搜索联系人").fill("不存在"); await button(page, "搜索联系人").click(); await page.getByRole("status").filter({ hasText: "已加载 0 位联系人" }).waitFor();
    await field(page, "搜索联系人").fill("PERSON"); await button(page, "搜索联系人").click(); await button(page, "编辑联系人 同邮箱新联系人").waitFor();
    await page.getByRole("combobox", { name: "权限", exact: true }).selectOption("contacts"); await field(page, "名称").fill("contacts automation"); await button(page, "创建 Key").click();
    const token = await page.getByTestId("new-key").textContent(); expect(await h.request("/api/v1/contacts", { token, origin: null })); expect(await h.request("/api/v1/mailboxes", { token, origin: null }), 403);
    await page.reload(); await button(page, "联系人").click(); await button(page, "编辑联系人 同邮箱新联系人").waitFor();
    await button(page, "退出登录").click(); await field(page, "用户名").fill(bob.username); await field(page, "密码").fill(PASSWORD); await button(page, "登录").click();
    await button(page, "联系人").click(); await page.getByRole("status").filter({ hasText: "已加载 0 位联系人" }).waitFor(); assert.equal(await field(page, "联系人邮箱").inputValue(), "");
    await h.db.batch(Array.from({ length: 52 }, (_, i) => h.db.prepare(`INSERT INTO contacts(user_id,id,display_name,name_key,email_address,version,created_at,updated_at)
      VALUES(?,?,?,?,?,1,unixepoch(),unixepoch())`).bind(bob.id, crypto.randomUUID(), `分页${i}`, `分页${i}`, `p${i}@example.test`)));
    await button(page, "刷新联系人").click(); await page.getByRole("status").filter({ hasText: "已加载 50 位联系人" }).waitFor();
    await button(page, "加载更多联系人").click(); await page.getByRole("status").filter({ hasText: "已加载 52 位联系人" }).waitFor();
    await field(page, "搜索联系人").fill("p51@"); await button(page, "搜索联系人").click(); await page.getByRole("status").filter({ hasText: "已加载 1 位联系人" }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(h.directory, "contacts-mobile.png"), fullPage: true });
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0); assert.equal(await page.evaluate(() => window.contactExecuted), undefined);
    assert.deepEqual(errors, []); assert.deepEqual(external, []); console.log(`Contacts browser evidence: ${h.directory}`);
  } catch (error) {
    if (page) { console.error(await page.locator("body").ariaSnapshot()); await page.screenshot({ path: path.join(h.directory, "contacts-failure.png"), fullPage: true }); }
    throw error;
  } finally { await browser?.close(); await f.close(); }
});
