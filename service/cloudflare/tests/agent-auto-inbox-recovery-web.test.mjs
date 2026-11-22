import assert from "node:assert/strict";
import { test } from "node:test";
import { expect } from "./agent-services-fixture.mjs";
import { autoInboxWebFixture } from "./agent-auto-inbox-web-fixture.mjs";

test("Chrome: unknown automatic authorization keeps original key/body across navigation, rejects malformed receipts and never replays a confirmed write after refresh failure", { timeout: 90000 }, async () => {
  const t = await autoInboxWebFixture(), { page, automatic, accounts } = t;
  try {
    await t.open(); const keys = [], bodies = []; let reads = 0, valid = false, failRefresh = false;
    await page.route(`**${t.base}/auto-inbox`, async route => {
      if (route.request().method() === "GET") return failRefresh ? route.fulfill({ status: 503, json: { error: { code: "agent_auto_inbox_unconfirmed" } } }) : route.continue();
      keys.push(route.request().headers()["idempotency-key"]); bodies.push(route.request().postData());
      if (keys.length === 1) return route.abort("failed"); await route.fetch(); return route.fulfill({ status: 200, json: {} });
    });
    await page.route("**/api/v1/agent-inbox-automation-operations/*", route => {
      reads++; return valid || reads === 1 ? route.continue() : route.fulfill({ status: 200, json: {} });
    });
    await automatic.getByLabel("启用 Agent 自动收件", { exact: true }).check(); await automatic.getByRole("button", { name: "保存自动收件", exact: true }).click();
    await automatic.getByRole("alert").filter({ hasText: "连接失败" }).waitFor();
    const recover = automatic.getByRole("button", { name: "核对原自动收件配置", exact: true });
    assert.equal(await accounts.getByRole("button", { name: "添加 Agent 邮箱", exact: true }).isDisabled(), true);
    assert.equal(await accounts.getByRole("button", { name: "同步 Agent 邮箱", exact: true }).isDisabled(), true);
    await page.getByRole("navigation").getByRole("button", { name: "Agent 服务", exact: true }).click();
    await page.getByRole("navigation").getByRole("button", { name: "Agent 邮箱", exact: true }).click();
    await recover.click(); await automatic.getByRole("alert").filter({ hasText: "响应不匹配" }).waitFor();
    await recover.click(); await automatic.getByRole("alert").filter({ hasText: "响应不匹配" }).waitFor();
    assert.equal(keys.length, 2); assert.equal(new Set(keys).size, 1); assert.equal(new Set(bodies).size, 1); assert.equal(t.dialogs.length, 1);
    valid = true; failRefresh = true; await recover.click(); await automatic.getByRole("status").filter({ hasText: "配置已确认" }).waitFor();
    await automatic.getByRole("alert").waitFor(); assert.equal(await recover.count(), 0); assert.equal(keys.length, 2);
    failRefresh = false; await automatic.getByRole("button", { name: "刷新自动收件", exact: true }).click();
    await automatic.getByText("配置版本 1 · 已启用", { exact: true }).waitFor(); await t.tick(); assert.equal(t.opens.length, 1);
    await page.reload(); await page.getByRole("navigation").getByRole("button", { name: "Agent 邮箱", exact: true }).click();
    await accounts.getByRole("button", { name: "普通邮箱", exact: true }).click(); await automatic.getByText("配置版本 1 · 已启用", { exact: true }).waitFor();
    assert.equal(keys.length, 2); assert.equal(t.opens.length, 1); assert.deepEqual(t.errors, []);
  } catch (error) { console.error(await page.locator("body").ariaSnapshot()); throw error; }
  finally { await t.close(); }
});

test("Chrome: obsolete original CAS plus a second exact 404 releases an absent intent; logout does not revoke confirmed authorization or replay it", { timeout: 90000 }, async () => {
  const t = await autoInboxWebFixture(), { page, automatic } = t;
  try {
    await t.open(); let writes = 0;
    await page.route(`**${t.base}/auto-inbox`, route => { if (route.request().method() === "PUT" && ++writes === 1) return route.abort("failed"); return route.continue(); });
    await automatic.getByLabel("启用 Agent 自动收件", { exact: true }).check(); await automatic.getByRole("button", { name: "保存自动收件", exact: true }).click();
    await automatic.getByRole("alert").filter({ hasText: "连接失败" }).waitFor(); expect(await t.configure());
    await automatic.getByRole("button", { name: "核对原自动收件配置", exact: true }).click();
    await automatic.getByRole("alert").filter({ hasText: "版本已变化" }).waitFor();
    assert.equal(await automatic.getByRole("button", { name: "核对原自动收件配置", exact: true }).count(), 0);
    await automatic.getByRole("button", { name: "刷新自动收件", exact: true }).click(); await automatic.getByText("配置版本 1 · 已启用", { exact: true }).waitFor();
    const bob = await t.h.register("automatic-web-bob"); await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await t.tick(); assert.equal(t.opens.length, 1); await t.login(bob);
    await page.getByRole("navigation").getByRole("button", { name: "Agent 邮箱", exact: true }).click();
    await page.getByText("暂无 Agent 邮箱", { exact: true }).waitFor(); assert.equal(await automatic.count(), 0); assert.equal(writes, 2);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  } finally { await t.close(); }
});
