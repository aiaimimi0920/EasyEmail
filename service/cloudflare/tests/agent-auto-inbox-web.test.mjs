import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { expect } from "./agent-services-fixture.mjs";
import { autoInboxWebFixture } from "./agent-auto-inbox-web-fixture.mjs";

test("Chrome: explicit automatic receive, observed status, account rebind, disabling, minimal Key and mobile", { timeout: 90000 }, async () => {
  const t = await autoInboxWebFixture(), { page, automatic, accounts } = t;
  try {
    await t.open(); assert.equal(await automatic.getByLabel("启用 Agent 自动收件", { exact: true }).isChecked(), false);
    await t.tick(); assert.equal(t.opens.length, 0);
    await automatic.getByLabel("启用 Agent 自动收件", { exact: true }).check();
    await automatic.getByRole("combobox", { name: "自动收件间隔", exact: true }).selectOption("5");
    await automatic.getByRole("button", { name: "保存自动收件", exact: true }).click();
    await automatic.getByRole("status").filter({ hasText: "配置已确认" }).waitFor(); assert.equal(t.opens.length, 0);
    assert.match(t.dialogs[0], /退出网页或撤销本次 Key 不会停止/);
    await t.tick(); assert.equal(t.opens.length, 1);
    await automatic.getByRole("button", { name: "刷新自动收件", exact: true }).click();
    await automatic.getByRole("status").filter({ hasText: "本次收件已提交" }).waitFor();
    expect(await t.save({ displayName: "新 Agent 名称" }, 1));
    await accounts.getByRole("button", { name: "刷新 Agent 邮箱", exact: true }).click();
    await automatic.getByText("配置版本 1 · 需重新确认账号", { exact: true }).waitFor(); await t.tick(); assert.equal(t.opens.length, 1);
    await automatic.getByRole("button", { name: "保存自动收件", exact: true }).click();
    await automatic.getByText("配置版本 2 · 已启用", { exact: true }).waitFor(); await t.tick(); assert.equal(t.opens.length, 2);
    await automatic.getByLabel("启用 Agent 自动收件", { exact: true }).uncheck(); await automatic.getByRole("button", { name: "保存自动收件", exact: true }).click();
    await automatic.getByText("配置版本 3 · 已关闭", { exact: true }).waitFor(); await t.due(); await t.tick(); assert.equal(t.opens.length, 2);
    await page.getByRole("combobox", { name: "权限", exact: true }).selectOption("agent-auto-inbox");
    await page.getByLabel("名称", { exact: true }).fill("自动收件 API"); await page.getByRole("button", { name: "创建 Key", exact: true }).click();
    const token = await page.getByTestId("new-key").textContent(), keys = expect(await t.h.request("/api/v1/api-keys", { cookie: t.alice.cookie })).items;
    assert.deepEqual(keys.find(row => row.name === "自动收件 API").scopes, ["agent-accounts:read", "agent-inbox:automate"]);
    expect(await t.config({ token }), 200); expect(await t.messages("", { token }), 403);
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(t.h.directory, "agent-auto-inbox-mobile.png"), fullPage: true });
    assert.deepEqual(t.errors, []); assert.deepEqual(t.external, []); assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  } catch (error) { console.error(await page.locator("body").ariaSnapshot()); throw error; }
  finally { await t.close(); }
});
