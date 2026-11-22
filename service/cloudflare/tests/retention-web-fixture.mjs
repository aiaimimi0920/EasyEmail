import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { createHarness, PASSWORD } from "./runtime-harness.mjs";
import { sendFixture } from "./send-fixture.mjs";

export async function retentionWebFixture() {
  const f = await sendFixture();
  let h, browser;
  try {
    h = await createHarness(f.bindings, true);
    const admin = await h.register("retention-web-admin"), alice = await h.register("retention-web-user");
    await h.db.prepare("INSERT INTO platform_admins VALUES (?,unixepoch())").bind(admin.id).run();
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); page.setDefaultTimeout(10000);
    const errors = [], external = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => { if (!request.url().startsWith(h.baseUrl.origin)) external.push(request.url()); });
    async function login(target, username) {
      await target.goto(h.baseUrl.href);
      await target.getByLabel("用户名", { exact: true }).fill(username);
      await target.getByLabel("密码", { exact: true }).fill(PASSWORD);
      await target.getByRole("button", { name: "登录", exact: true }).click();
      await target.getByRole("button", { name: "退出登录", exact: true }).waitFor();
    }
    const panel = page.getByRole("region", { name: "数据保留", exact: true });
    async function open() {
      await page.getByRole("button", { name: "平台管理", exact: true }).click();
      await panel.getByLabel("启用自动保留策略", { exact: true }).waitFor();
      await panel.getByRole("button", { name: "刷新保留策略", exact: true }).waitFor({ state: "visible" });
      await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent === "刷新保留策略" && !button.disabled));
    }
    async function request(button, path, method) {
      const response = page.waitForResponse((res) => res.url().endsWith(path) && res.request().method() === method);
      await panel.getByRole("button", { name: button, exact: true }).click();
      const result = await response; assert.equal(result.status(), 200); return result.json();
    }
    return { h, f, admin, alice, browser, page, panel, login, open, request, errors, external,
      async close() { await browser.close(); await h.close(); await f.close(); } };
  } catch (error) { await browser?.close(); await h?.close(); await f.close(); throw error; }
}
