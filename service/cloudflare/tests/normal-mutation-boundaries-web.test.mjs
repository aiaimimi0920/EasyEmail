import assert from "node:assert/strict";
import { test } from "node:test";
import { mutationOperationFixture } from "./normal-mutation-operation-fixture.mjs";
import { openMutationUi, chooseMove, button } from "./normal-mutation-web-fixture.mjs";

test("Chrome: pending durable operation locks source until a manual read observes completion", { timeout: 120000 }, async () => {
  const t = await mutationOperationFixture({ browser: true }), gate = t.holdCommand(/ UID MOVE /); let ui, writing;
  try {
    writing = t.mutate(); await gate.entered; ui = await openMutationUi(t); const { page, detail } = ui;
    await detail.getByRole("status").filter({ hasText: "原操作仍在处理中" }).waitFor();
    assert.equal(await button(detail, "永久删除服务器邮件").isDisabled(), true);
    assert.equal(await button(detail, "选择服务器移动目标").isDisabled(), true);
    assert.equal(await button(detail, "服务器加星标").isDisabled(), true);
    const opens = t.opens.length;
    gate.release(); assert.equal((await writing).body.operation.state, "confirmed"); writing = null;
    await button(detail, "只读刷新移动／删除记录").click();
    await detail.getByRole("status").filter({ hasText: "源邮件移除已确认" }).waitFor();
    assert.equal(t.opens.length, opens); assert.equal(t.calls.filter(line => / UID MOVE /.test(line)).length, 1);
    assert.equal(await page.getByTestId("remote-mutation-request-key").count(), 0);
    assert.deepEqual(ui.errors, []); assert.deepEqual(ui.external, []);
  } catch (error) { if (ui) console.error(await ui.page.locator("body").ariaSnapshot()); throw error; }
  finally { gate.release(); await writing; await ui?.browser.close(); await t.close(); }
});
test("Chrome: late destination response cannot transfer source confirmation across directory navigation", { timeout: 120000 }, async () => {
  const t = await mutationOperationFixture({ browser: true }); let ui, release;
  try {
    ui = await openMutationUi(t); const { page, detail } = ui; let entered;
    const blocked = new Promise(resolve => { entered = resolve; }), wait = new Promise(resolve => { release = resolve; });
    const target = `**${t.folderPath(t.destination)}/messages?limit=1`;
    await page.route(target, async route => { const response = await route.fetch(); entered(); await wait; await route.fulfill({ response }).catch(() => {}); });
    await detail.getByRole("checkbox", { name: /^确认永久删除服务器邮件/ }).check();
    await button(detail, "选择服务器移动目标").click();
    await detail.getByRole("combobox", { name: "服务器移动目标", exact: true }).selectOption(t.folder(t.destination).id); await blocked;
    const catalog = page.getByRole("region", { name: "服务器文件夹", exact: true });
    await button(catalog, "查看 中文 邮件").click(); await button(catalog, "Archive mail").click();
    const current = catalog.getByRole("region", { name: "普通邮件详情", exact: true });
    release(); await button(current, "选择服务器移动目标").waitFor({ state: "visible" });
    assert.equal(await current.getByRole("checkbox", { name: /^确认永久删除服务器邮件/ }).isChecked(), false);
    assert.equal(await button(current, "永久删除服务器邮件").isDisabled(), true);
    assert.equal(await current.getByRole("combobox", { name: "服务器移动目标", exact: true }).count(), 0);
    assert.equal(t.calls.filter(line => / UID (MOVE|COPY|STORE|EXPUNGE) /.test(line)).length, 0);
    assert.deepEqual(ui.errors, []); assert.deepEqual(ui.external, []);
  } catch (error) { if (ui) console.error(await ui.page.locator("body").ariaSnapshot()); throw error; }
  finally { release?.(); await ui?.browser.close(); await t.close(); }
});
test("Chrome: changed destination epoch after confirmation is rejected before a socket or reservation", { timeout: 120000 }, async () => {
  const t = await mutationOperationFixture({ browser: true }); let ui;
  try {
    ui = await openMutationUi(t); const { page, detail } = ui;
    await chooseMove(detail, t.folder(t.destination)); const opens = t.opens.length;
    await t.h.db.prepare("UPDATE normal_server_folder_state SET epoch_id=? WHERE account_id=? AND server_folder_id=?")
      .bind(crypto.randomUUID(), t.id, t.folder(t.destination).id).run();
    await button(detail, "移动服务器邮件").click();
    await page.getByRole("alert").filter({ hasText: "目标目录没有当前有效同步记录" }).waitFor();
    assert.equal(await page.getByTestId("remote-mutation-request-key").count(), 0);
    assert.equal(await detail.getByRole("checkbox", { name: /^确认从 / }).isChecked(), false);
    assert.equal(t.opens.length, opens);
    assert.equal((await t.h.db.prepare("SELECT COUNT(*) AS n FROM normal_remote_mutation_operations WHERE account_id=?").bind(t.id).first()).n, 0);
    assert.deepEqual(ui.errors, []); assert.deepEqual(ui.external, []);
  } catch (error) { if (ui) console.error(await ui.page.locator("body").ariaSnapshot()); throw error; }
  finally { await ui?.browser.close(); await t.close(); }
});
