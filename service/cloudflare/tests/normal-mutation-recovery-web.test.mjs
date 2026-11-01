import assert from "node:assert/strict";
import { test } from "node:test";
import { mutationOperationFixture } from "./normal-mutation-operation-fixture.mjs";
import { openMutationUi, chooseMove, button } from "./normal-mutation-web-fixture.mjs";

test("Chrome: wrong POST, held GET and latest receipts cannot release original folder request", { timeout: 120000 }, async () => {
  const t = await mutationOperationFixture({ browser: true }); let ui;
  try {
    ui = await openMutationUi(t); const { page, detail } = ui, posts = [];
    await page.route(`**${t.path}`, async route => {
      if (route.request().method() !== "POST") return route.continue();
      posts.push(route.request().headers()["idempotency-key"]);
      const response = await route.fetch(), body = await response.json(); body.operation.destinationEpochId = crypto.randomUUID();
      await route.fulfill({ response, json: body });
    });
    await chooseMove(detail, t.folder(t.destination)); await button(detail, "移动服务器邮件").click();
    await page.getByRole("alert").filter({ hasText: "服务器移动／删除回执不匹配" }).first().waitFor();
    assert.equal(await page.getByTestId("remote-mutation-request-key").textContent(), posts[0]);
    await page.route("**/remote-mutation-operations/*", async route => {
      const response = await route.fetch(), body = await response.json(); body.operation.serverFolderId = "0".repeat(64);
      await route.fulfill({ response, json: body });
    });
    await button(page, "只读核对原移动／删除").click();
    await page.getByRole("alert").filter({ hasText: "服务器移动／删除回执不匹配" }).first().waitFor();
    assert.equal(await page.getByTestId("remote-mutation-request-key").textContent(), posts[0]);
    assert.equal(await button(detail, "永久删除服务器邮件").isDisabled(), true);
    await page.unroute("**/remote-mutation-operations/*"); await button(page, "只读核对原移动／删除").click();
    await page.getByRole("status").filter({ hasText: "服务器移动／删除已确认" }).waitFor();
    await page.unroute(`**${t.path}`);
    await page.route(`**${t.path}`, async route => {
      const response = await route.fetch(), body = await response.json(); body.operation.serverFolderId = "0".repeat(64);
      await route.fulfill({ response, json: body });
    });
    await page.reload(); const current = await ui.reopen();
    await current.getByRole("alert").filter({ hasText: "服务器移动／删除回执不匹配" }).waitFor();
    assert.equal(await button(current, "永久删除服务器邮件").isDisabled(), true);
    assert.equal(await button(current, "服务器加星标").isDisabled(), true);
    await page.unroute(`**${t.path}`); await button(current, "只读刷新移动／删除记录").click();
    await current.getByRole("status").filter({ hasText: "源邮件移除已确认" }).waitFor();
    assert.equal(posts.length, 1); assert.equal(t.calls.filter(line => / UID MOVE /.test(line)).length, 1);
    assert.deepEqual(ui.errors, []); assert.deepEqual(ui.external, []);
  } catch (error) { if (ui) console.error(await ui.page.locator("body").ariaSnapshot()); throw error; }
  finally { await ui?.browser.close(); await t.close(); }
});
test("Chrome: durable unknown stays read-only across reload without acknowledgement or automatic retry", { timeout: 120000 }, async () => {
  const t = await mutationOperationFixture({ browser: true }); let ui;
  try {
    ui = await openMutationUi(t); const { page, detail } = ui, posts = [];
    t.scenario({ copyResponse: ({ tag }) => `${tag} NO synthetic uncertain move\r\n` });
    await page.route("**/remote-mutations", route => {
      if (route.request().method() === "POST") posts.push(route.request().headers()["idempotency-key"]);
      return route.continue();
    });
    await chooseMove(detail, t.folder(t.destination)); await button(detail, "移动服务器邮件").click();
    await detail.getByRole("alert").filter({ hasText: "原移动／删除结果未知" }).waitFor();
    assert.equal(await page.getByTestId("remote-mutation-request-key").textContent(), posts[0]);
    await button(page, "只读核对原移动／删除").click();
    await page.getByRole("status").filter({ hasText: "原服务器移动／删除结果未知" }).waitFor();
    assert.equal(await page.getByTestId("remote-mutation-request-key").textContent(), posts[0]);
    const commands = t.calls.length, opens = t.opens.length;
    await page.reload(); const current = await ui.reopen();
    await current.getByRole("alert").filter({ hasText: "原移动／删除结果未知" }).waitFor();
    assert.equal(await button(current, "永久删除服务器邮件").isDisabled(), true);
    assert.equal(await button(current, "选择服务器移动目标").isDisabled(), true);
    assert.equal(await current.getByRole("checkbox", { name: /核对服务器状态/ }).count(), 0);
    await button(current, "只读刷新移动／删除记录").click();
    await current.getByRole("alert").filter({ hasText: "原移动／删除结果未知" }).waitFor();
    assert.equal(posts.length, 1); assert.equal(t.calls.length, commands); assert.equal(t.opens.length, opens);
    assert.deepEqual(ui.errors, []); assert.deepEqual(ui.external, []);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  } catch (error) { if (ui) console.error(await ui.page.locator("body").ariaSnapshot()); throw error; }
  finally { await ui?.browser.close(); await t.close(); }
});
test("Chrome: unsynced target never opens IMAP and changing target clears risk confirmation", { timeout: 120000 }, async () => {
  const t = await mutationOperationFixture({ browser: true }); let ui;
  try {
    ui = await openMutationUi(t); const { detail } = ui, opens = t.opens.length;
    await button(detail, "选择服务器移动目标").click();
    const choices = detail.getByRole("combobox", { name: "服务器移动目标", exact: true });
    await choices.selectOption(t.folder("INBOX").id);
    await detail.getByRole("alert").filter({ hasText: "目标目录没有当前有效同步记录" }).waitFor();
    assert.equal(await button(detail, "移动服务器邮件").isDisabled(), true);
    await choices.selectOption(t.folder(t.destination).id); const confirmation = detail.getByRole("checkbox", { name: /^确认从 / }); await confirmation.check();
    assert.equal(await button(detail, "移动服务器邮件").isEnabled(), true);
    await choices.selectOption(t.folder("INBOX").id);
    await detail.getByRole("alert").filter({ hasText: "目标目录没有当前有效同步记录" }).waitFor();
    assert.equal(await confirmation.isChecked(), false); assert.equal(await button(detail, "移动服务器邮件").isDisabled(), true);
    assert.equal(t.opens.length, opens); assert.equal(t.calls.filter(line => / UID (MOVE|COPY|STORE|EXPUNGE) /.test(line)).length, 0);
    assert.deepEqual(ui.errors, []); assert.deepEqual(ui.external, []);
  } catch (error) { if (ui) console.error(await ui.page.locator("body").ariaSnapshot()); throw error; }
  finally { await ui?.browser.close(); await t.close(); }
});
test("Chrome: move and permanent-delete API presets grant separate minimal scopes", { timeout: 120000 }, async () => {
  const t = await mutationOperationFixture({ browser: true }); let ui;
  try {
    ui = await openMutationUi(t); const { page } = ui;
    for (const action of ["move", "delete"]) {
      await page.getByRole("textbox", { name: "名称", exact: true }).fill(`mutation-${action}`);
      await page.getByRole("combobox", { name: "权限", exact: true }).selectOption(`normal-remote-${action}`);
      await button(page, "创建 Key").click(); await page.getByTestId("new-key").waitFor();
      const key = await t.h.db.prepare("SELECT scopes FROM api_keys WHERE user_id=? AND name=?").bind(t.alice.id, `mutation-${action}`).first();
      assert.deepEqual(JSON.parse(key.scopes), ["mail-accounts:read", "messages:read", `mail-accounts:remote-${action}`]);
      await button(page, "隐藏").click();
    }
    assert.equal(t.calls.filter(line => / UID (MOVE|COPY|STORE|EXPUNGE) /.test(line)).length, 0);
    assert.deepEqual(ui.errors, []); assert.deepEqual(ui.external, []);
  } finally { await ui?.browser.close(); await t.close(); }
});
