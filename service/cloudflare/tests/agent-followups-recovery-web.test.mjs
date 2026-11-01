import assert from "node:assert/strict";
import { test } from "node:test";
import { agentFollowupsWebFixture } from "./agent-followups-web-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";
import { PASSWORD } from "./runtime-harness.mjs";

test("Chrome: uncertain follow-ups retain the original key/body through navigation, reconcile GET before replay and never relock after a confirmed refresh failure", { timeout: 90000 }, async () => {
  const t = await agentFollowupsWebFixture();
  try {
    const task = expect(await t.enqueue({ ...t.input, subject: "未知跟进原线程" }), 201).task; await t.run();
    expect(await t.enqueue({ ...t.input, subject: "其他跟进线程" }), 201); await t.run(); await t.open(task.subject);
    const { page, followups, threads } = t, keys = [], bodies = [], sequence = []; let reads = 0, valid = false, failRefresh = false;
    page.on("dialog", dialog => dialog.accept());
    await page.route(`**/api/v1/agent-threads/${task.id}/followups`, async route => {
      keys.push(route.request().headers()["idempotency-key"]); bodies.push(route.request().postData()); sequence.push("POST");
      if (keys.length === 1) return route.abort("failed"); await route.fetch(); return route.fulfill({ status: 201, json: {} });
    });
    await page.route("**/api/v1/agent-followups?requestKey=*", route => { sequence.push("GET"); reads++; return valid || reads === 1 ? route.continue() : route.fulfill({ status: 200, json: {} }); });
    await page.route(`**/api/v1/agent-threads/${task.id}/followup-context`, route => failRefresh ? route.fulfill({ status: 503, json: { error: { code: "synthetic_followup_context_failed" } } }) : route.continue());
    await t.compose("未知网页跟进"); await followups.getByRole("button", { name: "排队发送同线程跟进", exact: true }).click();
    const recover = followups.getByRole("button", { name: "核对原跟进操作", exact: true }); await recover.waitFor();
    assert.equal(await threads.getByRole("combobox", { name: "线程状态筛选", exact: true }).isDisabled(), true);
    assert.equal(await threads.getByRole("button", { name: "其他跟进线程", exact: true }).isDisabled(), true);
    assert.equal(await t.detail.getByRole("button", { name: "标记人工完成", exact: true }).isDisabled(), true);
    assert.equal(await followups.getByRole("textbox", { name: "跟进正文", exact: true }).isDisabled(), true);
    await page.getByRole("navigation").getByRole("button", { name: "Agent 服务", exact: true }).click();
    await page.getByRole("navigation").getByRole("button", { name: "Agent 线程", exact: true }).click(); await recover.click();
    await followups.getByRole("alert").filter({ hasText: "跟进响应不匹配" }).waitFor();
    assert.deepEqual(sequence, ["POST", "GET", "POST"]); assert.equal(new Set(keys).size, 1); assert.equal(new Set(bodies).size, 1);
    await recover.click(); await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "核对原跟进操作" && !button.disabled));
    assert.deepEqual(sequence, ["POST", "GET", "POST", "GET"]); assert.equal(keys.length, 2);
    valid = true; failRefresh = true; await recover.click(); await followups.getByRole("alert").filter({ hasText: "synthetic_followup_context_failed" }).waitFor();
    assert.equal(await recover.count(), 0); assert.equal(await threads.getByRole("combobox", { name: "线程状态筛选", exact: true }).isEnabled(), true);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_followups").first("n"), 1); assert.equal(keys.length, 2);
    failRefresh = false; await followups.getByRole("button", { name: "刷新跟进来源与记录", exact: true }).click();
    await followups.getByRole("button", { name: "排队发送同线程跟进", exact: true }).waitFor(); assert.deepEqual(t.errors, []);
  } catch (error) { console.error(await t.page.locator("body").ariaSnapshot()); throw error; }
  finally { await t.close(); }
});

test("Chrome: uncertain queued cancellation reconciles by ID without another POST; refresh and logout never persist or automatically replay a follow-up", { timeout: 90000 }, async () => {
  const t = await agentFollowupsWebFixture();
  try {
    const task = expect(await t.enqueue({ ...t.input, subject: "取消与退出跟进线程" }), 201).task; await t.run(); await t.open(task.subject);
    const { page, followups } = t; page.on("dialog", dialog => dialog.accept()); await t.compose("取消未知跟进");
    await followups.getByRole("button", { name: "排队发送同线程跟进", exact: true }).click(); await followups.getByText("跟进请求已保存", { exact: true }).waitFor();
    const row = await t.h.db.prepare("SELECT * FROM agent_followups").first(); let cancels = 0;
    await page.route(`**/api/v1/agent-followups/${row.id}/cancel`, async route => { cancels++; await route.fetch(); return route.abort("failed"); });
    await followups.getByRole("button", { name: "取消这封跟进派发", exact: true }).click(); await followups.getByRole("button", { name: "核对原跟进操作", exact: true }).click();
    await followups.getByText("跟进派发已取消", { exact: true }).waitFor(); assert.equal(cancels, 1); await t.run(); assert.equal(t.messages.length, 1);
    let sends = 0; await page.route(`**/api/v1/agent-threads/${task.id}/followups`, async route => { sends++; await route.fetch(); return route.abort("failed"); });
    await t.compose("刷新时未决跟进"); await followups.getByRole("button", { name: "排队发送同线程跟进", exact: true }).click();
    await followups.getByRole("button", { name: "核对原跟进操作", exact: true }).waitFor(); assert.equal(sends, 1);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0); await page.reload();
    await page.getByRole("navigation").getByRole("button", { name: "Agent 线程", exact: true }).click(); await t.threads.getByRole("button", { name: task.subject, exact: true }).click();
    await followups.getByText("暂无同线程跟进", { exact: true }).waitFor({ state: "detached" });
    assert.equal(await followups.getByRole("button", { name: "核对原跟进操作", exact: true }).count(), 0); assert.equal(sends, 1);
    const bob = await t.h.register("followup-browser-bob"); await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await page.getByLabel("用户名", { exact: true }).fill(bob.username); await page.getByLabel("密码", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "登录", exact: true }).click(); await page.getByRole("navigation").getByRole("button", { name: "Agent 线程", exact: true }).click();
    await t.threads.getByText("暂无 Agent 线程", { exact: true }).waitFor(); assert.equal(await t.detail.count(), 0); assert.equal(sends, 1);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_followups").first("n"), 2); assert.deepEqual(t.errors, []);
  } catch (error) { console.error(await t.page.locator("body").ariaSnapshot()); throw error; }
  finally { await t.close(); }
});
