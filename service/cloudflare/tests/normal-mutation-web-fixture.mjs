import { chromium } from "playwright-core";
import { PASSWORD } from "./runtime-harness.mjs";

export const button = (page, name) => page.getByRole("button", { name, exact: true });
export async function openMutationUi(t, source = t.source) {
  const browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); page.setDefaultTimeout(15000);
    const errors = [], external = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (!request.url().startsWith(t.h.baseUrl.origin)) external.push(request.url()); });
    await page.goto(t.h.baseUrl.href); await page.getByLabel("用户名", { exact: true }).fill(t.alice.username);
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await button(page, "登录").click();
    async function detail(name = source, subject = name === "INBOX" ? "Inbox mail" : name === "Sent" ? "Sent mail" : "Archive mail") {
      await button(page.getByRole("navigation"), "普通邮箱").click();
      const normal = page.getByRole("region", { name: "普通邮箱", exact: true }); await button(normal, "普通邮箱").click();
      const catalog = normal.getByRole("region", { name: "服务器文件夹", exact: true });
      await button(catalog, `查看 ${t.folder(name).name} 邮件`).click(); await button(catalog, subject).click();
      return catalog.getByRole("region", { name: "普通邮件详情", exact: true });
    }
    return { browser, page, detail: await detail(), reopen: detail, errors, external };
  } catch (error) { await browser.close(); throw error; }
}
export async function chooseMove(detail, folder) {
  await button(detail, "选择服务器移动目标").click(); await detail.getByRole("combobox", { name: "服务器移动目标", exact: true }).selectOption(folder.id);
  const confirmation = detail.getByRole("checkbox", { name: /^确认从 / }); await confirmation.check();
}
