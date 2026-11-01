import { chromium } from "playwright-core";
import { PASSWORD } from "./runtime-harness.mjs";
import { agentFollowupsMailFixture } from "./agent-followups-mail-fixture.mjs";

export async function agentFollowupsWebFixture() {
  const t = await agentFollowupsMailFixture({ browser: true }); let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } }), errors = [];
    page.setDefaultTimeout(10000); page.on("pageerror", error => errors.push(error.message));
    const threads = page.getByRole("region", { name: "Agent 线程", exact: true });
    const detail = threads.getByRole("article", { name: "Agent 线程详情", exact: true });
    const followups = detail.getByRole("region", { name: "Agent 同线程跟进", exact: true });
    return { ...t, browser, page, errors, threads, detail, followups,
      async open(title) {
        await page.goto(t.h.baseUrl.href); await page.getByLabel("用户名", { exact: true }).fill(t.alice.username);
        await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await page.getByRole("button", { name: "登录", exact: true }).click();
        await page.getByRole("navigation").getByRole("button", { name: "Agent 线程", exact: true }).click();
        await threads.getByRole("button", { name: title, exact: true }).click(); await followups.waitFor();
      },
      async compose(subject, text = "合成网页跟进正文") {
        await followups.getByLabel("跟进主题", { exact: true }).fill(subject); await followups.getByLabel("跟进正文", { exact: true }).fill(text);
        await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "排队发送同线程跟进" && !button.disabled));
      },
      async close() { try { await browser.close(); } finally { await t.close(); } },
    };
  } catch (error) { await browser?.close(); await t.close(); throw error; }
}
