import { chromium } from "playwright-core";
import { autoInboxFixture } from "./agent-auto-inbox-fixture.mjs";
import { PASSWORD } from "./runtime-harness.mjs";
export async function autoInboxWebFixture() {
  const t = await autoInboxFixture({ browser: true }); let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } }), errors = [], dialogs = [], external = [];
    page.setDefaultTimeout(12000); page.on("pageerror", error => errors.push(error.message));
    page.on("dialog", async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
    page.on("request", request => { if (!request.url().startsWith(t.h.baseUrl.origin)) external.push(request.url()); });
    const accounts = page.getByRole("region", { name: "Agent 邮箱", exact: true }), automatic = accounts.getByRole("region", { name: "Agent 自动收件", exact: true });
    return { ...t, browser, page, accounts, automatic, errors, dialogs, external,
      async login(user = t.alice) {
        await page.goto(t.h.baseUrl.href); await page.getByLabel("用户名", { exact: true }).fill(user.username);
        await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await page.getByRole("button", { name: "登录", exact: true }).click();
      },
      async open() {
        await this.login(); await page.getByRole("navigation").getByRole("button", { name: "Agent 邮箱", exact: true }).click();
        await accounts.getByRole("button", { name: "普通邮箱", exact: true }).click();
        await automatic.getByRole("button", { name: "保存自动收件", exact: true }).waitFor();
      },
      async close() { try { await browser.close(); } finally { await t.close(); } },
    };
  } catch (error) { await browser?.close(); await t.close(); throw error; }
}
