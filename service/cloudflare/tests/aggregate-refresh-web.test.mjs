import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

test("Chrome offline: aggregate search keeps a matching reader on refresh and closes a stale reader", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const bundle = await build({ absWorkingDir: root, entryPoints: ["web/app.tsx"], bundle: true, write: false,
    jsx: "automatic", loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"production"' } });
  const browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH
    ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  try {
    const page = await browser.newPage({ offline: true, serviceWorkers: "block" });
    page.setDefaultTimeout(5000);
    const origin = "http://127.0.0.1", unexpected = [], errors = [];
    const message = { id: "m1", mailboxId: "b1", sourceKind: "temporary", subject: "取件通知", textBody: "请到前台",
      htmlBody: "", attachments: [], sender: "sender@example.test", recipient: "box@example.test", trashedAt: null };
    let matches = true, filteredReads = 0;
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
      const url = new URL(route.request().url()), path = url.pathname;
      if (url.origin !== origin || route.request().method() !== "GET") {
        unexpected.push(url.href); return route.abort();
      }
      if (path === "/") return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
      if (path === "/api/v1/me") return route.fulfill({ json: { user: { id: "u1", username: "fixture", role: "user" } } });
      if (path === "/api/v1/auth/config") return route.fulfill({ json: { auth: { mode: "local" } } });
      if (path === "/api/v1/messages") {
        if (url.searchParams.get("q") === "取件") filteredReads++;
        return route.fulfill({ json: { items: matches ? [message] : [], nextCursor: null } });
      }
      if (path === "/api/v1/mailboxes/b1/messages/m1") return route.fulfill({ json: { message } });
      return route.fulfill({ json: { items: [], nextCursor: null } });
    });
    await page.goto(origin);
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.getByRole("navigation").getByRole("button", { name: "聚合收件箱", exact: true }).click();
    const region = page.getByRole("region", { name: "聚合邮件" }), search = region.getByLabel("搜索缓存邮件");
    await search.fill("取件");
    await region.getByRole("button", { name: "搜索邮件", exact: true }).click();
    await region.getByRole("button", { name: message.subject, exact: true }).click();
    const body = region.getByTestId("mail-body"), refresh = region.getByRole("button", { name: "刷新缓存列表" });
    await body.getByText(message.textBody, { exact: true }).waitFor();
    await refresh.click();
    await region.getByRole("button", { name: message.subject, pressed: true }).waitFor();
    await body.getByText(message.textBody, { exact: true }).waitFor();
    matches = false; // Still readable by ID, but no longer in the current search results.
    await refresh.click();
    await region.getByText("暂无匹配的缓存邮件", { exact: true }).waitFor();
    assert.equal(await region.getByRole("article", { name: "邮件详情" }).count(), 0, "stale reader remains beside empty results");
    await region.getByRole("heading", { name: "选择一封邮件" }).waitFor();
    assert.equal(await search.inputValue(), "取件");
    assert.equal(filteredReads, 3);
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  } finally { await browser.close(); }
});
