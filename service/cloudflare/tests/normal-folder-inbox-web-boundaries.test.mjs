import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { normalFolderInboxFixture } from "./normal-folder-inbox-fixture.mjs";
import { PASSWORD } from "./runtime-harness.mjs";

const button = (scope, name) => scope.getByRole("button", { name, exact: true });
for (const mode of ["json-408", "json-429", "missing-state", "wrong-folder", "wrong-key", "catalog-removed"]) {
  test(`Chrome: ${mode} after committed sync retains original key and read-only reconciliation`, { timeout: 90000 }, async () => {
    const t = await normalFolderInboxFixture({ browser: true }); let browser;
    try {
      browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
      const page = await browser.newPage();
      await page.goto(t.h.baseUrl.href); await page.getByLabel("用户名", { exact: true }).fill(t.alice.username);
      await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await button(page, "登录").click();
      const nav = page.getByRole("navigation"); await button(nav, "普通邮箱").click();
      const account = page.getByRole("region", { name: "普通邮箱", exact: true }); await button(account, "普通邮箱").click();
      const catalog = account.getByRole("region", { name: "服务器文件夹", exact: true }); await button(catalog, "查看 Sent 邮件").click();
      const inbox = catalog.getByRole("region", { name: "服务器文件夹邮件", exact: true }); await inbox.getByText("暂无缓存邮件", { exact: true }).waitFor();
      let key, posts = 0; const queries = [];
      page.on("request", request => { if (request.method() === "GET" && request.url().includes("/sync-requests/")) queries.push(request.url()); });
      await page.route(`**${t.folderPath("Sent")}/sync`, async route => {
        posts++; key = route.request().headers()["idempotency-key"];
        const response = await route.fetch(), result = await response.json();
        assert.equal(result.request.state, "committed");
        if (mode === "json-408" || mode === "json-429") return route.fulfill({ status: mode === "json-408" ? 408 : 429,
          contentType: "application/json", body: JSON.stringify({ error: { code: "unknown_transport_outcome" } }) });
        if (mode === "missing-state" || mode === "catalog-removed") delete result.request.state;
        if (mode === "wrong-folder") result.request.serverFolderId = "f".repeat(64);
        if (mode === "wrong-key") result.request.requestKey = crypto.randomUUID();
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(result) });
      });
      const opens = t.opens.length; await button(inbox, "同步此文件夹").click(); await button(inbox, "核对文件夹同步").waitFor();
      assert.equal(await button(catalog, "关闭文件夹邮件").isDisabled(), true);
      if (mode === "catalog-removed") {
        await t.h.db.prepare("UPDATE normal_server_folder_catalogs SET folders='[]' WHERE account_id=?").bind(t.id).run();
        await button(nav, "联系人").click(); await button(nav, "普通邮箱").click();
        await catalog.getByText("服务器返回空目录", { exact: true }).waitFor();
        assert.equal(await button(inbox, "核对文件夹同步").count(), 1);
      }
      await button(inbox, "核对文件夹同步").click(); await button(inbox, "同步此文件夹").waitFor();
      assert.equal(posts, 1); assert.equal(t.opens.length, opens + 1); assert.equal(queries.length, 1);
      assert.ok(queries[0].endsWith(`/sync-requests/${key}`));
      await button(catalog, "关闭文件夹邮件").click(); assert.equal(await inbox.count(), 0);
      const receipt = await t.request(`${t.folderPath("Sent")}/sync-requests/${key}`); assert.equal(receipt.body.request.state, "committed", receipt.text);
    } finally { try { await browser?.close(); } finally { await t.close(); } }
  });
}
