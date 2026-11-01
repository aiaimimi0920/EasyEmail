import assert from "node:assert/strict";
import { test } from "node:test";
import { agentFollowupsWebFixture } from "./agent-followups-web-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";

test("Chrome: restricted and uncertain predecessor risks require an explicit new confirmation; no unknown Message-ID is automatically resent", { timeout: 90000 }, async () => {
  const t = await agentFollowupsWebFixture();
  try {
    await t.h.db.prepare("UPDATE agent_services SET trust_level='restricted',version=2 WHERE id=?").bind(t.serviceId).run();
    const task = expect(await t.enqueue({ ...t.input, serviceVersion: 2, confirmRestricted: true, subject: "受限未知线程" }), 201).task; await t.run();
    const previous = expect(await t.followup(task.id, await t.followupInput(task.id, { confirmRestricted: true })), 201).followup;
    t.mode("drop-final"); await t.run(); assert.equal(expect(await t.followupRead(previous.id)).followup.state, "unknown");
    t.mode("normal"); await t.open(task.subject); await t.compose("显式承担不确定性的跟进"); const { page, followups } = t;
    page.once("dialog", dialog => { assert.match(dialog.message(), /受限服务/); assert.match(dialog.message(), /前序邮件结果未确认/); return dialog.dismiss(); });
    await followups.getByRole("button", { name: "排队发送同线程跟进", exact: true }).click();
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_followups").first("n"), 1);
    page.once("dialog", dialog => { assert.match(dialog.message(), /前序邮件结果未确认/); return dialog.accept(); });
    await followups.getByRole("button", { name: "排队发送同线程跟进", exact: true }).click(); await followups.getByText("跟进请求已保存", { exact: true }).waitFor();
    const row = await t.h.db.prepare("SELECT * FROM agent_followups WHERE id<>?").bind(previous.id).first();
    assert.equal(row.confirm_uncertain, 1); assert.equal(row.confirm_restricted, 1); assert.notEqual(row.rfc_message_id, previous.messageId);
    await t.run(); assert.equal(t.messages.length, 3); assert.equal(expect(await t.followupRead(previous.id)).followup.state, "unknown");
    assert.equal(expect(await t.followupRead(row.id)).followup.state, "accepted"); assert.deepEqual(t.errors, []);
  } catch (error) { console.error(await t.page.locator("body").ariaSnapshot()); throw error; }
  finally { await t.close(); }
});

test("Chrome: follow-up pagination preserves one real root; changed actual routing disables new sends while historical records remain readable", { timeout: 90000 }, async () => {
  const t = await agentFollowupsWebFixture();
  try {
    const task = expect(await t.enqueue({ ...t.input, subject: "跟进分页线程" }), 201).task; await t.run();
    const input = await t.followupInput(task.id); for (let i = 0; i < 21; i++) expect(await t.followup(task.id, { ...input, subject: `分页跟进-${i}` }), 201);
    await t.open(task.subject); const { page, followups } = t; await followups.getByRole("button", { name: "加载更多跟进", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('section[aria-label="Agent 同线程跟进"] > ul')?.children.length === 21);
    assert.equal(await followups.locator(":scope > ul > li").count(), 21);
    await t.h.db.prepare("UPDATE agent_services SET email_address='changed@example.test',version=version+1 WHERE id=?").bind(t.serviceId).run();
    await followups.getByRole("button", { name: "刷新跟进来源与记录", exact: true }).click();
    await followups.getByRole("alert").filter({ hasText: "线程实际收发地址已变化" }).waitFor();
    assert.equal(await followups.getByRole("button", { name: "排队发送同线程跟进", exact: true }).isDisabled(), true);
    const id = await t.h.db.prepare("SELECT subject FROM agent_followups ORDER BY id LIMIT 1").first("subject");
    await followups.getByRole("button", { name: id, exact: true }).click(); await followups.getByRole("article", { name: "Agent 跟进详情", exact: true }).waitFor();
    assert.equal(t.messages.length, 1); assert.deepEqual(t.errors, []);
  } catch (error) { console.error(await t.page.locator("body").ariaSnapshot()); throw error; }
  finally { await t.close(); }
});
