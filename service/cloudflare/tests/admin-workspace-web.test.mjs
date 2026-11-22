import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { createHarness, PASSWORD } from "./runtime-harness.mjs";
import { providerFixture } from "./provider-fixture.mjs";

test("Chrome: changed domains refresh on workspace return and disabled catalogs never hide uncertain creation reconciliation", { timeout: 60000 }, async () => {
  const f = await providerFixture();
  let h, browser;
  try {
    h = await createHarness(f.bindings, true);
    const admin = await h.register("admin-workspace-operator");
    await h.db.prepare("INSERT INTO platform_admins VALUES (?,unixepoch())").bind(admin.id).run();
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    const page = await browser.newPage(); page.setDefaultTimeout(10000);
    await page.goto(h.baseUrl.href);
    await page.getByLabel("用户名", { exact: true }).fill("admin-workspace-operator");
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByRole("combobox", { name: "域名", exact: true }).selectOption("cf.example.test");
    await page.getByRole("button", { name: "平台管理", exact: true }).click();
    await page.getByRole("button", { name: "编辑 self", exact: true }).click();
    await page.getByRole("textbox", { name: "域名白名单", exact: true }).fill("other.example.test");
    await page.getByRole("button", { name: "保存供应商", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "供应商配置已保存" }).waitFor();
    await page.getByRole("button", { name: "邮箱管理", exact: true }).click();
    await page.getByRole("combobox", { name: "域名", exact: true }).selectOption("other.example.test");
    f.modes.set("/cf/admin/new_address", "disconnect");
    await page.getByRole("button", { name: "分配随机邮箱", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "创建结果待确认" }).waitFor();
    const guard = await h.db.prepare("SELECT * FROM mailbox_creations LIMIT 1").first();
    assert.equal(guard.state, "unknown");
    await page.getByRole("button", { name: "平台管理", exact: true }).click();
    const list = (await h.request("/api/v1/admin/providers", { cookie: admin.cookie })).body.items;
    for (const row of list) {
      const saved = await h.request(`/api/v1/admin/providers/${row.config.id}`, { cookie: admin.cookie, method: "PUT",
        body: { expectedRevision: row.revision, config: { ...row.config, enabled: false }, secretAction: "keep" } });
      assert.equal(saved.status, 200, saved.text);
    }
    const catalogResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/providers");
    await page.getByRole("button", { name: "邮箱管理", exact: true }).click();
    const catalog = await catalogResponse;
    assert.deepEqual((await catalog.json()).items, []);
    const checking = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/mailbox-creations/${guard.mailbox_id}` && response.request().method() === "GET");
    await page.getByRole("button", { name: "检查创建结果", exact: true }).click();
    const checked = await checking;
    assert.equal(checked.status(), 200);
    const result = (await checked.json()).creation;
    assert.equal(result.requestKey, guard.request_key);
    assert.equal(result.state, "unknown"); assert.equal(result.retrySafe, false);
    assert.equal(f.calls.filter((call) => call.path === "/cf/admin/new_address").length, 1);
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM mailbox_creations").first()).n, 1);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  } finally { await browser?.close(); await h?.close(); await f.close(); }
});
