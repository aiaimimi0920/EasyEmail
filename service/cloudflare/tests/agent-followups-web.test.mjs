import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { agentFollowupsWebFixture } from "./agent-followups-web-fixture.mjs";
import { followupReply } from "./agent-followups-mail-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";

test("Chrome: task-root follow-ups explicitly confirm actual routing, send independent MIME parents, cancel only queued intent and mint a least-privileged Key", { timeout: 90000 }, async () => {
  const t = await agentFollowupsWebFixture();
  try {
    const task = expect(await t.enqueue({ ...t.input, subject: "网页原始任务" }), 201).task; await t.run(); await t.open(task.subject);
    const { page, followups } = t; await t.compose("第一封网页跟进");
    page.once("dialog", dialog => dialog.dismiss()); await followups.getByRole("button", { name: "排队发送同线程跟进", exact: true }).click();
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_followups").first("n"), 0);
    page.on("dialog", dialog => { if (dialog.message().includes("确认发送")) { assert.match(dialog.message(), /sender@example.test/); assert.match(dialog.message(), /agent@example.test/); } return dialog.accept(); });
    await followups.getByRole("button", { name: "排队发送同线程跟进", exact: true }).click(); await followups.getByText("跟进请求已保存", { exact: true }).waitFor();
    const first = (await t.h.db.prepare("SELECT * FROM agent_followups").first()); assert.equal(first.reply_type, "task"); assert.equal(first.reply_id, task.id);
    assert.equal(t.messages.length, 1); await t.run(); assert.equal(t.messages.length, 2); assert.ok(t.messages[1].includes(`In-Reply-To: ${task.messageId}`));
    await followups.getByRole("button", { name: "刷新跟进状态", exact: true }).click();
    await followups.getByRole("status").filter({ hasText: "SMTP 已接受，送达未确认" }).waitFor();
    await followups.getByRole("button", { name: "回复这封跟进", exact: true }).click(); await t.compose("第二封网页跟进");
    await followups.getByRole("button", { name: "排队发送同线程跟进", exact: true }).click();
    await followups.getByRole("article", { name: "Agent 跟进详情", exact: true }).getByRole("heading", { name: "第二封网页跟进", exact: true }).waitFor();
    const second = await t.h.db.prepare("SELECT * FROM agent_followups WHERE subject=?").bind("第二封网页跟进").first();
    assert.equal(second.reply_type, "followup"); assert.equal(second.reply_id, first.id);
    assert.equal(second.in_reply_to, first.rfc_message_id); assert.deepEqual(JSON.parse(second.references_json), [task.messageId, first.rfc_message_id]);
    await followups.getByRole("button", { name: "取消这封跟进派发", exact: true }).click(); await followups.getByText("跟进派发已取消", { exact: true }).waitFor();
    await t.run(); assert.equal(t.messages.length, 2); assert.equal(await t.h.db.prepare("SELECT state FROM agent_followups WHERE id=?").bind(second.id).first("state"), "cancelled");
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_threads").first("n"), 1);
    await page.getByRole("combobox", { name: "权限", exact: true }).selectOption("agent-followups"); await page.getByLabel("名称", { exact: true }).fill("follow-up only");
    await page.getByRole("button", { name: "创建 Key", exact: true }).click(); const token = await page.getByTestId("new-key").textContent();
    const scopes = JSON.parse(await t.h.db.prepare("SELECT scopes FROM api_keys WHERE name='follow-up only'").first("scopes"));
    assert.deepEqual(scopes, ["agent-tasks:read", "agent-threads:send", "agent-inbox:read"]);
    expect(await t.followupRead(first.id, { token })); expect(await t.h.request("/api/v1/agent-tasks", { method: "POST", token, body: {} }), 403);
    expect(await t.h.request(`/api/v1/agent-threads/${task.id}/state`, { method: "PUT", token, body: {} }), 403);
    expect(await t.h.request(`/api/v1/agent-accounts/${t.accountId}`, { method: "PUT", token, body: {} }), 403);
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(t.h.directory, "agent-followups-mobile.png"), fullPage: true });
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0); assert.deepEqual(t.errors, []);
  } catch (error) { console.error(await t.page.locator("body").ariaSnapshot()); throw error; }
  finally { await t.close(); }
});

test("Chrome: inbound-root reply is explicitly chosen from the safe inbox, sends without a fake task and receives into the same real root", { timeout: 90000 }, async () => {
  const t = await agentFollowupsWebFixture();
  try {
    const raw = followupReply(null, { headers: "", subject: "入站种子" }); t.scenario({ uidNext: 2, messages: new Map([[1, raw]]) }); expect(await t.receive());
    const seed = expect(await t.inbox()).items[0], root = await t.inbound(seed); await t.open(`入站线程 · ${root}`);
    const { page, followups } = t; const inbox = t.detail.getByRole("region", { name: "入站线程来信", exact: true });
    assert.equal(await followups.getByRole("button", { name: "排队发送同线程跟进", exact: true }).isDisabled(), true);
    await inbox.getByRole("button", { name: "入站种子", exact: true }).click(); await inbox.getByRole("button", { name: "回复这封 Agent 来信", exact: true }).click();
    await t.compose("入站网页跟进"); page.on("dialog", dialog => { assert.match(dialog.message(), /来信发件身份未验证/); return dialog.accept(); });
    await followups.getByRole("button", { name: "排队发送同线程跟进", exact: true }).click(); await followups.getByText("跟进请求已保存", { exact: true }).waitFor();
    const outgoing = await t.h.db.prepare("SELECT * FROM agent_followups").first(); assert.equal(outgoing.thread_id, root); assert.equal(outgoing.reply_id, seed.id);
    await t.run(); assert.equal(t.messages.length, 1); const seedRfc = await t.h.db.prepare("SELECT rfc_message_id FROM agent_incoming_messages WHERE id=?").bind(seed.id).first("rfc_message_id");
    assert.ok(t.messages[0].includes(`In-Reply-To: ${seedRfc}`)); assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM agent_threads").first("n"), 0);
    const reply = followupReply(outgoing.rfc_message_id, { subject: "跟进的新回信" });
    t.scenario({ uidNext: 3, messages: new Map([[1, raw], [2, reply]]) }); expect(await t.receive());
    await inbox.getByRole("button", { name: "刷新 Agent 缓存", exact: true }).click(); await inbox.getByRole("button", { name: "跟进的新回信", exact: true }).click();
    await inbox.getByText("已建入站线程 · 发件身份未验证", { exact: true }).waitFor();
    const incoming = expect(await t.inbox(`?threadId=${root}`)).items.find(row => row.subject === "跟进的新回信");
    assert.deepEqual(incoming.inboundThread, { id: root, active: true }); assert.equal(incoming.threadId, null); assert.deepEqual(t.errors, []);
  } catch (error) { console.error(await t.page.locator("body").ariaSnapshot()); throw error; }
  finally { await t.close(); }
});
