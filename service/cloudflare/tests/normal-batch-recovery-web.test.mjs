import assert from "node:assert/strict";
import { test } from "node:test";
import { normalBatchFixture, openNormalBatch, button, selection, captureNormalWrites, assertNormalPlatformOnly } from "./normal-batch-fixture.mjs";

test("Chrome: independent normal batch retains exact targets after lost commit, denied retry, navigation and missing receipt", { timeout: 120000 }, async () => {
  const t = await normalBatchFixture(); let browser, page;
  try {
    let inbox, normal; ({ browser, page, normal, inbox } = await openNormalBatch(t)); const writes = captureNormalWrites(page); let first = true, missing = true, reads = 0;
    await page.route(`**/api/v1/normal-accounts/${t.id}/messages/organize`, async route => {
      if (first) { first = false; const response = await route.fetch(); assert.equal(response.status(), 200); await response.dispose(); return route.abort("connectionfailed"); }
      await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { code: "forbidden" } }) });
    });
    await page.route(`**/api/v1/normal-accounts/${t.id}/organization-operations/*`, async route => {
      reads++; if (missing) { missing = false; return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "not_found" } }) }); }
      await route.continue();
    });
    await button(inbox, "选择当前页邮件").click(); await button(inbox, "批量加星标").click(); await button(page, "重试原普通整理").waitFor();
    assert.equal(writes.length, 1); assert.equal(writes[0].body.messageIds.length, 2);
    assert.equal(await button(inbox, "选择当前页邮件").isDisabled(), true); assert.equal(await button(normal, "移除普通邮箱").isDisabled(), true);
    await page.getByRole("navigation").getByRole("button", { name: "聚合收件箱", exact: true }).click();
    const aggregate = page.getByRole("region", { name: "聚合邮件", exact: true }); await button(aggregate, "选择当前页邮件").waitFor();
    assert.equal(await button(aggregate, "选择当前页邮件").isDisabled(), true);
    await button(page, "重试原普通整理").click(); await page.getByRole("alert").filter({ hasText: "forbidden" }).waitFor();
    assert.equal(writes.length, 2); assert.deepEqual(writes[0], writes[1]);
    await button(page, "核对原普通整理").click(); await page.getByRole("alert").filter({ hasText: "请求失败：not_found" }).waitFor();
    assert.equal(await button(aggregate, "选择当前页邮件").isDisabled(), true);
    assert.equal((await t.h.request(`${t.base}/messages/organize`, { method: "POST", cookie: t.alice.cookie,
      headers: { "idempotency-key": crypto.randomUUID() }, body: { messageIds: writes[0].body.messageIds, starred: false } })).status, 200);
    await button(page, "核对原普通整理").click(); await page.getByRole("status").filter({ hasText: "已整理 2 封普通邮件（已核对原操作）" }).waitFor();
    assert.equal(reads, 2); assert.equal(writes.length, 2);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_message_state WHERE starred=1").first("n"), 0);
    await page.getByRole("navigation").getByRole("button", { name: "普通邮箱", exact: true }).click();
    await button(inbox, "选择当前页邮件").click(); await selection(inbox, 2); await assertNormalPlatformOnly(t, page);
  } finally { await browser?.close(); await t.close(); }
});

test("Chrome: terminal failed synchronization remains visible after refreshing the batch list", { timeout: 90000 }, async () => {
  const t = await normalBatchFixture(); let browser, page;
  try {
    let inbox; ({ browser, page, inbox } = await openNormalBatch(t));
    await page.route(`**/api/v1/normal-accounts/${t.id}/sync`, route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      request: { id: crypto.randomUUID(), requestKey: route.request().headers()["idempotency-key"], accountId: t.id, accountRevision: 1, state: "failed",
        createdAt: 1, finishedAt: 2, result: null, errorCode: "normal_sync_interrupted" } }) }));
    const loaded = page.waitForResponse(response => response.url().includes(`/normal-accounts/${t.id}/messages?`) && response.request().method() === "GET");
    await button(inbox, "同步普通邮箱").click(); await loaded;
    await inbox.getByRole("status").filter({ hasText: "已加载 2 封" }).waitFor();
    assert.equal(await inbox.getByRole("alert").textContent(), "同步未提交或已中断，请查看记录后手动重新同步");
    assert.equal(await button(inbox, "核对本次同步").count(), 0); await selection(inbox, 0); await assertNormalPlatformOnly(t, page);
  } finally { await browser?.close(); await t.close(); }
});
