import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { PASSWORD } from "./runtime-harness.mjs";
import { remoteAllocationFixture, remoteAllocate } from "./remote-allocation-fixture.mjs";

async function webFixture() {
  const f = await remoteAllocationFixture(true), { h } = f; let browser, page;
  try {
    const user = await h.register("remote-web-user");
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    page = await browser.newPage({ viewport: { width: 390, height: 844 } }); page.setDefaultTimeout(10000);
    const errors = [], external = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (!request.url().startsWith(h.baseUrl.origin)) external.push(request.url()); });
    return { f, h, user, page, errors, external,
      async login() {
        await page.goto(h.baseUrl.href); await page.getByLabel("用户名", { exact: true }).fill(user.username);
        await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await page.getByRole("button", { name: "登录", exact: true }).click();
        await page.getByRole("button", { name: "退出登录", exact: true }).waitFor();
      },
      async audit() {
        const text = await page.locator("body").innerText(); assert.equal(text.includes("remote-random:"), false);
        assert.equal(text.includes("synthetic-remote-"), false); assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.deepEqual(errors, []); assert.deepEqual(external, []);
      },
      async close() { await browser.close(); await f.close(); },
    };
  } catch (error) { await browser?.close(); await f.close(); throw error; }
}

test("Chrome: remote allocation with a lost ACK shows no invented address, survives reload, and requires request-key risk confirmation before another allocation", { timeout: 90000 }, async () => {
  const a = await webFixture(), { f, h, page } = a;
  try {
    f.modes.add("lost-ack"); await a.login();
    await page.getByRole("button", { name: "分配随机邮箱", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "创建结果待确认：unknown" }).waitFor();
    const row = await h.db.prepare("SELECT * FROM mailbox_creations").first(); assert.equal(f.calls.length, 1);
    await a.audit(); await page.screenshot({ path: path.join(h.directory, "remote-unknown-mobile.png"), fullPage: true });
    await page.reload(); await page.getByRole("status").filter({ hasText: "创建结果待确认：unknown" }).waitFor();
    assert.equal(await page.getByRole("combobox", { name: "分配方式", exact: true }).isDisabled(), true);
    const checked = page.waitForResponse(res => res.url().endsWith(`/mailbox-creations/${row.mailbox_id}`));
    await page.getByRole("button", { name: "检查创建结果", exact: true }).click(); await checked; assert.equal(f.calls.length, 1);
    const confirmation = page.getByRole("form", { name: "未决创建确认", exact: true }), next = confirmation.getByRole("button");
    await confirmation.getByLabel("确认原请求键", { exact: true }).fill("wrong-request-key"); await confirmation.getByRole("checkbox").check();
    assert.equal(await next.isDisabled(), true); await confirmation.getByLabel("确认原请求键", { exact: true }).fill(row.request_key);
    await confirmation.getByRole("checkbox").uncheck(); assert.equal(await next.isDisabled(), true); await confirmation.getByRole("checkbox").check();
    const acknowledged = page.waitForResponse(res => res.url().endsWith(`/mailbox-creations/${row.mailbox_id}/acknowledge`));
    await next.click(); const ack = await acknowledged; assert.equal(ack.status(), 200);
    assert.deepEqual(ack.request().postDataJSON(), { confirmRequestKey: row.request_key, acknowledgeUncertain: true }); assert.equal(f.calls.length, 1);
    f.modes.clear(); await h.db.prepare("UPDATE provider_allocation_state SET cooldown_until=NULL").run();
    await page.getByRole("button", { name: "刷新供应商状态", exact: true }).click();
    const allocated = page.waitForResponse(res => res.url().endsWith("/api/v1/mailboxes") && res.request().method() === "POST");
    await page.getByRole("button", { name: "分配随机邮箱", exact: true }).click(); const response = await allocated; assert.equal(response.status(), 201);
    const box = (await response.json()).mailbox; assert.equal(box.address, f.allocations.at(-1).address); assert.notEqual(box.id, row.mailbox_id);
    await page.getByRole("button", { name: box.address, exact: true }).waitFor(); assert.equal(f.calls.length, 2);
    assert.equal((await h.db.prepare("SELECT state FROM mailbox_creations WHERE mailbox_id=?").bind(row.mailbox_id).first()).state, "unknown");
    await a.audit(); console.log(`Remote allocation unknown Chrome evidence: ${h.directory}`);
  } catch (error) { console.error(await page.locator("body").ariaSnapshot()); throw error; }
  finally { await a.close(); }
});

test("Chrome: an acknowledged pending remote allocation can finish with its actual address and expiry, then open from history without another write", { timeout: 90000 }, async () => {
  const a = await webFixture(), { f, h, page, user } = a; let gate;
  try {
    gate = f.hold(); const pending = remoteAllocate(h, user.cookie); await gate.entered;
    const row = await h.db.prepare("SELECT * FROM mailbox_creations").first(); await a.login();
    await page.getByRole("status").filter({ hasText: "创建结果待确认：pending" }).waitFor();
    const history = page.getByRole("region", { name: "创建历史", exact: true });
    assert.equal(await history.getByRole("button", { name: `查看创建 ${row.mailbox_id}`, exact: true }).textContent(), "地址待确认");
    await page.getByLabel("确认原请求键", { exact: true }).fill(row.request_key);
    await page.getByRole("form", { name: "未决创建确认", exact: true }).getByRole("checkbox").check();
    const acknowledged = page.waitForResponse(res => res.url().endsWith(`/mailbox-creations/${row.mailbox_id}/acknowledge`));
    await page.getByRole("button", { name: "保留未决记录，另起分配", exact: true }).click(); assert.equal((await acknowledged).status(), 200);
    gate.release(); const result = await pending; assert.equal(result.status, 201, result.text);
    const box = result.body.mailbox; assert.equal(box.address, f.allocations.at(-1).address); assert.equal(box.expiresAt, f.allocations.at(-1).expiresAt);
    await page.getByRole("button", { name: "刷新供应商状态", exact: true }).click(); await history.getByText(/已创建 · remote-fixture/).waitFor();
    await history.getByRole("button", { name: `查看创建 ${row.mailbox_id}`, exact: true }).click();
    await page.getByRole("heading", { name: "收件箱", exact: true }).waitFor(); assert.equal(f.calls.length, 1);
    await a.audit(); await page.screenshot({ path: path.join(h.directory, "remote-complete-mobile.png"), fullPage: true });
    console.log(`Remote allocation late success Chrome evidence: ${h.directory}`);
  } catch (error) { console.error(await page.locator("body").ariaSnapshot()); throw error; }
  finally { gate?.release(); await a.close(); }
});
