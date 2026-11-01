import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { createHarness, PASSWORD } from "./runtime-harness.mjs";
import { providerFixture } from "./provider-fixture.mjs";

test("Chrome: admin-only configuration, write-only secrets, explicit probes, CAS conflicts and ordinary-user isolation", { timeout: 90000 }, async () => {
  const f = await providerFixture();
  let h, browser, page;
  try {
    h = await createHarness(f.bindings, true);
    const admin = await h.register("admin-web-operator"); await h.register("admin-web-ordinary");
    await h.db.prepare("INSERT INTO platform_admins VALUES (?,unixepoch())").bind(admin.id).run();
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); page.setDefaultTimeout(10000);
    const errors = [], external = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => { if (!request.url().startsWith(h.baseUrl.origin)) external.push(request.url()); });
    const login = async (target, username) => {
      await target.goto(h.baseUrl.href);
      await target.getByLabel("用户名", { exact: true }).fill(username);
      await target.getByLabel("密码", { exact: true }).fill(PASSWORD);
      await target.getByRole("button", { name: "登录", exact: true }).click();
      await target.getByRole("button", { name: "退出登录", exact: true }).waitFor();
    };
    await login(page, "admin-web-operator");
    await page.getByRole("button", { name: "平台管理", exact: true }).click();
    await page.getByRole("heading", { name: "平台用量", exact: true }).waitFor();
    assert.equal(f.calls.length, 0, "Viewing admin never probes upstream");
    const save = async () => {
      const response = page.waitForResponse((res) => /\/admin\/providers\/self$/.test(res.url()) && res.request().method() === "PUT");
      await page.getByRole("button", { name: "保存供应商", exact: true }).click();
      return response;
    };
    const saved = () => page.getByRole("status").filter({ hasText: "供应商配置已保存" }).waitFor();
    await page.getByRole("button", { name: "编辑 self", exact: true }).click();
    assert.equal(await page.getByLabel("API 地址", { exact: true }).isDisabled(), true);
    await page.getByLabel("启用供应商", { exact: true }).uncheck(); assert.equal((await save()).status(), 200); await saved();
    assert.equal((await h.request("/api/v1/providers", { cookie: admin.cookie })).body.items.some((row) => row.id === "self"), false);
    await page.getByRole("button", { name: "编辑 self", exact: true }).click();
    await page.getByLabel("启用供应商", { exact: true }).check();
    await page.getByRole("combobox", { name: "凭据操作", exact: true }).selectOption("replace");
    await page.getByLabel("供应商 API Key", { exact: true }).fill("synthetic-cf-admin");
    await page.getByLabel("站点密码", { exact: true }).fill("synthetic-site-password");
    assert.equal((await save()).status(), 200); await saved();
    assert.equal(await page.getByLabel("供应商 API Key", { exact: true }).count(), 0);
    assert.equal((await page.locator("body").innerText()).includes("synthetic-cf-admin"), false);
    await page.getByRole("button", { name: "探测 self", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "self：接口探测通过" }).waitFor();
    assert.equal(f.calls.at(-1).path, "/cf/admin/worker/configs");
    await page.getByRole("button", { name: "编辑 self", exact: true }).click();
    await page.getByRole("combobox", { name: "凭据操作", exact: true }).selectOption("clear");
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByRole("button", { name: "保存供应商", exact: true }).click();
    assert.equal((await h.db.prepare("SELECT secret_source FROM provider_overrides WHERE id='self'").first()).secret_source, "stored");
    page.once("dialog", (dialog) => dialog.accept()); assert.equal((await save()).status(), 200); await saved();
    assert.equal((await h.db.prepare("SELECT secret_source FROM provider_overrides WHERE id='self'").first()).secret_source, "none");
    await page.getByRole("button", { name: "新增供应商", exact: true }).click();
    await page.getByLabel("实例 ID", { exact: true }).fill("secondary");
    await page.getByLabel("API 地址", { exact: true }).fill(JSON.parse(f.bindings.PROVIDER_CONFIG)[0].baseUrl);
    await page.getByLabel("域名白名单", { exact: true }).fill("cf.example.test");
    await page.getByRole("combobox", { name: "发送渠道", exact: true }).selectOption("worker");
    await page.getByLabel("允许收件地址", { exact: true }).fill("recipient@example.test");
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "保存供应商", exact: true }).click(); await saved();
    await page.getByRole("button", { name: "编辑 secondary", exact: true }).waitFor();
    await page.getByRole("button", { name: "编辑 secondary", exact: true }).click();
    await page.getByRole("combobox", { name: "发送渠道", exact: true }).selectOption("binding");
    const dialog = page.waitForEvent("dialog"), click = page.getByRole("button", { name: "保存供应商", exact: true }).click();
    await (await dialog).dismiss(); await click;
    assert.equal((await h.db.prepare("SELECT revision FROM provider_overrides WHERE id='secondary'").first()).revision, 1);
    await page.getByRole("button", { name: "取消编辑", exact: true }).click();
    await page.getByRole("button", { name: "编辑 self", exact: true }).click();
    const current = (await h.request("/api/v1/admin/providers", { cookie: admin.cookie })).body.items.find((row) => row.config.id === "self");
    const concurrent = await h.request("/api/v1/admin/providers/self", { cookie: admin.cookie, method: "PUT", body: {
      expectedRevision: current.revision, config: { ...current.config, enabled: false }, secretAction: "keep" } });
    assert.equal(concurrent.status, 200); assert.equal((await save()).status(), 409);
    await page.getByRole("alert").filter({ hasText: "配置已变化" }).waitFor();
    await page.getByRole("button", { name: "取消编辑", exact: true }).click();
    await page.getByRole("button", { name: "刷新管理数据", exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent === "刷新管理数据" && !button.disabled));
    assert.equal((await h.db.prepare("SELECT revision FROM provider_overrides WHERE id='self'").first()).revision, 4);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(h.directory, "admin-mobile.png"), fullPage: true });
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    const ordinary = await browser.newPage(); ordinary.setDefaultTimeout(10000);
    await login(ordinary, "admin-web-ordinary");
    assert.equal(await ordinary.getByRole("button", { name: "平台管理", exact: true }).count(), 0);
    assert.equal(await ordinary.evaluate(async () => (await fetch("/api/v1/admin/providers")).status), 403);
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log(`M3e Chrome evidence: ${h.directory}`);
  } catch (error) {
    if (page) { console.error(await page.locator("body").ariaSnapshot()); await page.screenshot({ path: path.join(h.directory, "admin-failure.png"), fullPage: true }); }
    throw error;
  } finally { await browser?.close(); await h?.close(); await f.close(); }
});
