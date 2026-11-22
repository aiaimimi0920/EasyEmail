import assert from "node:assert/strict";
import { test } from "node:test";
import { normalBatchFixture, openNormalBatch, button, combo, selection, captureNormalWrites, assertNormalPlatformOnly } from "./normal-batch-fixture.mjs";

// Synthetic list responses isolate browser pagination; mutations use the real backend in normal-batch-web.
test("Chrome: independent selection caps at fifty, selects only latest page and resets on refresh, folder and account changes", { timeout: 90000 }, async () => {
  const t = await normalBatchFixture(); let browser, page;
  try {
    const template = (await t.messages()).body, seed = template.items[0];
    const rows = Array.from({ length: 51 }, (_, index) => ({ ...seed, id: crypto.randomUUID(), uid: index + 1 }));
    const other = crypto.randomUUID(); assert.equal((await t.save({ displayName: "另一普通邮箱", emailAddress: "other@example.test" }, 0, t.alice.cookie, other)).status, 201);
    let inbox, normal; ({ browser, page, normal, inbox } = await openNormalBatch(t, async current => {
      await current.route(`**/api/v1/normal-accounts/${t.id}/messages?*`, async route => {
        const query = new URL(route.request().url()).searchParams, index = Number(query.get("cursor") ?? 0), folder = query.get("folder");
        const all = folder === "archive" ? rows.slice(0, 3) : rows;
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...template,
          items: all.slice(index, index + 20), nextCursor: index + 20 < all.length ? String(index + 20) : null }) });
      });
    })); const writes = captureNormalWrites(page);
    assert.equal(await inbox.getByRole("checkbox").count(), 20); await button(inbox, "选择当前页邮件").click(); await selection(inbox, 20);
    await button(inbox, "加载更多普通邮件").click(); await inbox.getByRole("status").filter({ hasText: "已加载 40 封" }).waitFor();
    for (const checkbox of await inbox.getByRole("checkbox").all()) if (!await checkbox.isChecked()) await checkbox.check();
    await selection(inbox, 40); await button(inbox, "加载更多普通邮件").click(); await inbox.getByRole("status").filter({ hasText: "已加载 51 封" }).waitFor();
    for (const checkbox of await inbox.getByRole("checkbox").all()) if (!await checkbox.isChecked() && await checkbox.isEnabled()) await checkbox.check();
    await selection(inbox, 50); assert.equal(await inbox.getByRole("checkbox", { checked: false }).isDisabled(), true);
    await button(inbox, "选择当前页邮件").click(); await selection(inbox, 11);
    await button(inbox, "刷新缓存邮件").click(); await inbox.getByRole("status").filter({ hasText: "已加载 20 封" }).waitFor(); await selection(inbox, 0);
    await button(inbox, "选择当前页邮件").click(); await combo(inbox, "普通平台文件夹").selectOption("archive");
    await inbox.getByRole("status").filter({ hasText: "已加载 3 封" }).waitFor(); await selection(inbox, 0);
    await button(inbox, "选择当前页邮件").click(); await button(normal, "另一普通邮箱").click();
    await inbox.getByText("暂无缓存邮件", { exact: true }).waitFor(); await selection(inbox, 0);
    assert.deepEqual(writes, []); await assertNormalPlatformOnly(t, page);
  } finally { await browser?.close(); await t.close(); }
});

test("Chrome: refresh supersedes an in-flight older page, clears selection and blocks writes while reading", { timeout: 90000 }, async () => {
  const t = await normalBatchFixture(); let browser, page, release;
  try {
    const template = (await t.messages()).body; let entered, settled;
    const gate = new Promise(resolve => { entered = resolve; }), wait = new Promise(resolve => { release = resolve; });
    const complete = new Promise(resolve => { settled = resolve; });
    let inbox; ({ browser, page, inbox } = await openNormalBatch(t, async current => {
      await current.route(`**/api/v1/normal-accounts/${t.id}/messages?*`, async route => {
        const more = new URL(route.request().url()).searchParams.has("cursor");
        if (more) { entered(); await wait; }
        const response = more ? { ...template, items: [{ ...template.items[0], id: crypto.randomUUID(), subject: "迟到旧页" }], nextCursor: null }
          : { ...template, nextCursor: "older-page" };
        try { await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response) }); }
        catch (failure) { if (!more) throw failure; } finally { if (more) settled(); }
      });
    })); const writes = captureNormalWrites(page);
    await button(inbox, "选择当前页邮件").click(); await button(inbox, "加载更多普通邮件").click(); await gate;
    assert.equal(await button(inbox, "批量加星标").isDisabled(), true);
    await button(inbox, "刷新缓存邮件").click(); await selection(inbox, 0);
    await inbox.getByRole("status").filter({ hasText: "已加载 2 封" }).waitFor(); release(); await complete;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await button(inbox, "迟到旧页").count(), 0); assert.equal(await inbox.getByRole("checkbox").count(), 2);
    assert.deepEqual(writes, []); await assertNormalPlatformOnly(t, page);
  } finally { release?.(); await browser?.close(); await t.close(); }
});
