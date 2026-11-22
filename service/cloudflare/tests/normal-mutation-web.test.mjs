import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { mutationOperationFixture } from "./normal-mutation-operation-fixture.mjs";
import { mailboxData } from "./normal-folder-inbox-fixture.mjs";
import { openMutationUi, chooseMove, button } from "./normal-mutation-web-fixture.mjs";

test("Chrome: explicit folder move survives lost POST and navigation, preserves caches and all shared details", { timeout: 120000 }, async () => {
  const mailboxes = mailboxData(), sent = mailboxes.get("Sent");
  sent.messages.set(2, new TextEncoder().encode(new TextDecoder().decode(sent.messages.get(2)).replace("Subject: Sent mail",
    "Subject: Sent mail\r\nMessage-ID: <mutation-web@example.test>\r\nList-ID: Updates <updates.example.test>")));
  const t = await mutationOperationFixture({ browser: true, mailboxes }); let ui;
  try {
    await t.receive("INBOX"); ui = await openMutationUi(t); const { page, detail } = ui;
    const source = await t.sourceRows(), target = (await t.messages(t.destination)).body.items, posts = [], reads = [], opens = t.opens.length;
    assert.equal(await button(detail, "移动服务器邮件").count(), 0);
    await page.route(`**${t.path}`, async route => {
      if (route.request().method() !== "POST") return route.continue();
      posts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() });
      await route.fetch(); await route.abort("connectionfailed");
    });
    await page.route("**/remote-mutation-operations/*", route => { reads.push(route.request().url()); return route.continue(); });
    await chooseMove(detail, t.folder(t.destination)); assert.equal(t.opens.length, opens);
    await button(detail, "移动服务器邮件").click(); await page.getByTestId("remote-mutation-request-key").waitFor();
    const key = await page.getByTestId("remote-mutation-request-key").textContent(); assert.equal(key, posts[0].key); assert.deepEqual(posts[0].body, t.body);
    await button(page.getByRole("navigation"), "联系人").click(); await button(page.getByRole("navigation"), "聚合收件箱").click();
    assert.equal(await page.getByTestId("remote-mutation-request-key").textContent(), key);
    await button(page, "只读核对原移动／删除").click(); await page.getByRole("status").filter({ hasText: "服务器移动／删除已确认" }).waitFor();
    assert.equal(reads.length, 1); assert.ok(reads[0].endsWith(`${t.sourceBase}/remote-mutation-operations/${key}`));
    const aggregate = page.getByRole("region", { name: "聚合邮件", exact: true }); await button(aggregate, "Sent mail").click();
    await aggregate.getByRole("status").filter({ hasText: "源邮件移除已确认" }).waitFor();
    await button(aggregate, "会话视图").click(); await aggregate.getByRole("button", { name: /^打开会话 Sent mail/ }).click();
    const members = aggregate.getByRole("region", { name: "会话邮件", exact: true }); await button(members, "Sent mail").click();
    await members.getByRole("status").filter({ hasText: "源邮件移除已确认" }).waitFor();
    await button(page.getByRole("navigation"), "订阅邮件").click(); await button(page, "查看订阅 Updates").click();
    const subscription = page.getByRole("region", { name: "订阅成员", exact: true }); await button(subscription, "Sent mail").click();
    await subscription.getByRole("status").filter({ hasText: "源邮件移除已确认" }).waitFor();
    assert.equal(await button(subscription, "永久删除服务器邮件").isDisabled(), true);
    assert.deepEqual(await t.sourceRows(), source); assert.deepEqual((await t.messages(t.destination)).body.items, target);
    assert.equal(t.calls.filter(line => / UID MOVE /.test(line)).length, 1); assert.equal(t.opens.length, opens + 1); assert.equal(posts.length, 1);
    await page.reload(); const reloaded = await ui.reopen(); await reloaded.getByRole("status").filter({ hasText: "源邮件移除已确认" }).waitFor();
    assert.equal(await button(reloaded, "服务器加星标").isDisabled(), true); assert.equal(posts.length, 1);
    assert.deepEqual(ui.errors, []); assert.deepEqual(ui.external, []); assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(t.h.directory, "mutation-move-mobile.png"), fullPage: true }); console.log(`Mutation move evidence: ${t.h.directory}`);
  } catch (error) { if (ui) console.error(await ui.page.locator("body").ariaSnapshot()); throw error; }
  finally { await ui?.browser.close(); await t.close(); }
});
test("Chrome: permanent INBOX delete uses canonical path and separate confirmation, never platform trash", { timeout: 120000 }, async () => {
  const t = await mutationOperationFixture({ browser: true, source: "INBOX" }); let ui;
  try {
    ui = await openMutationUi(t); const { page, detail } = ui, before = await t.sourceRows(), posts = [];
    await page.route("**/remote-mutations", async route => {
      if (route.request().method() === "POST") posts.push({ url: route.request().url(), body: route.request().postDataJSON() });
      return route.continue();
    });
    assert.equal(await button(detail, "永久删除服务器邮件").isDisabled(), true);
    await detail.getByRole("checkbox", { name: "确认永久删除服务器邮件，无法撤销；这不是平台回收站操作", exact: true }).check();
    await button(detail, "永久删除服务器邮件").click(); await detail.getByRole("status").filter({ hasText: "源邮件移除已确认" }).waitFor();
    assert.equal(posts.length, 1); assert.ok(posts[0].url.endsWith(t.path)); assert.ok(!posts[0].url.includes("server-folders"));
    assert.deepEqual(posts[0].body, { expectedRevision: 1, epochId: t.item.epochId, action: "delete", confirmPermanentDelete: true });
    assert.equal(t.calls.filter(line => / UID STORE .*Deleted/.test(line)).length, 1); assert.equal(t.calls.filter(line => / UID EXPUNGE /.test(line)).length, 1);
    assert.deepEqual(await t.sourceRows(), before); assert.equal(await page.getByTestId("remote-mutation-request-key").count(), 0);
    assert.deepEqual(ui.errors, []); assert.deepEqual(ui.external, []);
  } catch (error) { if (ui) console.error(await ui.page.locator("body").ariaSnapshot()); throw error; }
  finally { await ui?.browser.close(); await t.close(); }
});
