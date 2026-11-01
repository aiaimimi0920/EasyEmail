import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { createHarness, PASSWORD } from "./runtime-harness.mjs";
import { allocate, cfMail, providerFixture } from "./provider-fixture.mjs";

async function fixture() {
  const f = await providerFixture();
  let h, browser, page;
  try {
    h = await createHarness(f.bindings, true);
    const user = await h.register("single-mailbox-search");
    const box = (await allocate(h, user.cookie)).body.mailbox;
    const other = (await allocate(h, user.cookie)).body.mailbox;
    f.messages.set(box.address, Array.from({ length: 29 }, (_, index) => ({
      ...cfMail(box.address, index + 1, index < 27 ? "Project & +中文 review" : "Other memo",
        index === 28 ? "2026-10-01 12:00:00" : "2026-10-30 12:00:00"),
      sender: index === 27 ? "other@example.test" : "team@example.test", subject: `Memo ${index + 1}`,
    })));
    f.messages.set(other.address, [{ ...cfMail(other.address, 101, "Project & +中文 review"), subject: "Other mailbox secret" }]);
    for (const [mailbox, pages] of [[box, 3], [other, 1]]) {
      for (let n = 1; n <= pages; n++) {
        const result = await h.request(`/api/v1/mailboxes/${mailbox.id}/sync`, { cookie: user.cookie, method: "POST", body: { page: n } });
        assert.equal(result.status, 200, result.text);
      }
    }
    const archived = await h.db.prepare("SELECT id FROM messages WHERE mailbox_id=? AND subject='Memo 1'").bind(box.id).first();
    assert.equal((await h.request(`/api/v1/mailboxes/${box.id}/messages/${archived.id}`, {
      cookie: user.cookie, method: "PATCH", body: { archived: true },
    })).status, 200);
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH
      ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); page.setDefaultTimeout(10000);
    const errors = [], external = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (!request.url().startsWith(h.baseUrl.origin)) external.push(request.url()); });
    await page.goto(h.baseUrl.href);
    await page.getByLabel("用户名", { exact: true }).fill(user.username);
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByRole("button", { name: box.address, exact: true }).click();
    await page.getByRole("button", { name: /^Memo / }).first().waitFor();
    return { f, h, page, box, other, user, errors, external, close: async () => { await browser.close(); await h.close(); await f.close(); } };
  } catch (error) { await browser?.close(); await h?.close(); await f.close(); throw error; }
}

test("Chrome: single-mailbox cached search preserves ownership, filters, pagination, reset and paused access", { timeout: 120000 }, async () => {
  const t = await fixture();
  try {
    const { page, f, h, box, user } = t;
    assert.equal(await page.getByRole("button", { name: "搜索当前邮箱", exact: true }).count(), 1,
      "The single mailbox must expose ordinary cached-message search, not only OTP extraction");
    const reader = page.getByRole("region", { name: "单邮箱收件箱", exact: true });
    const search = reader.getByRole("form", { name: "单邮箱邮件搜索", exact: true });
    const queries = [];
    page.on("request", request => { const url = new URL(request.url()); if (url.pathname === "/api/v1/messages") queries.push(url); });
    const calls = f.calls.length;
    await search.getByLabel("搜索当前邮箱邮件", { exact: true }).fill("Project & +中文");
    await search.getByLabel("发件人筛选", { exact: true }).fill("team@example.test");
    await search.getByLabel("收件时间从", { exact: true }).fill("2026-10-29T00:00");
    await search.getByLabel("收件时间至", { exact: true }).fill("2026-10-31T23:59");
    await search.getByRole("button", { name: "搜索当前邮箱", exact: true }).click();
    await reader.getByRole("status").filter({ hasText: "已加载 25 封缓存邮件" }).waitFor();
    assert.equal(await reader.getByRole("button", { name: "Other mailbox secret", exact: true }).count(), 0);
    assert.equal(await reader.getByRole("button", { name: "Memo 28", exact: true }).count(), 0);
    await reader.getByRole("button", { name: "加载更多邮件", exact: true }).click();
    await reader.getByRole("status").filter({ hasText: "已加载 27 封缓存邮件" }).waitFor();
    assert.equal(await reader.getByRole("button", { name: /^Memo / }).count(), 27);
    assert.equal(await reader.getByRole("button", { name: "加载更多邮件", exact: true }).count(), 0);
    assert.equal(queries.at(-1).searchParams.get("mailboxId"), box.id);
    assert.equal(queries.at(-1).searchParams.get("q"), "Project & +中文");
    assert.equal(queries.at(-1).searchParams.get("folder"), "all");
    assert.ok(queries.at(-1).searchParams.get("cursor"));
    const expected = await page.evaluate(() => Math.floor(new Date("2026-10-29T00:00").getTime() / 1000));
    assert.equal(queries.at(-1).searchParams.get("since"), String(expected));
    await reader.getByRole("button", { name: "Memo 1", exact: true }).click();
    await reader.getByTestId("mail-body").waitFor();
    await search.getByRole("button", { name: "清除邮件筛选", exact: true }).click();
    await reader.getByRole("status").filter({ hasText: "已加载 25 封缓存邮件" }).waitFor();
    assert.equal(await search.getByLabel("搜索当前邮箱邮件", { exact: true }).inputValue(), "");
    await h.db.prepare("UPDATE mailboxes SET sync_error='synthetic_sync_state' WHERE id=?").bind(box.id).run();
    await reader.getByRole("button", { name: "加载更多邮件", exact: true }).click();
    await reader.getByRole("status").filter({ hasText: "已加载 29 封缓存邮件" }).waitFor();
    await reader.getByRole("status").filter({ hasText: "同步状态：synthetic_sync_state" }).waitFor();
    await h.db.prepare("UPDATE mailboxes SET sync_error=NULL WHERE id=?").bind(box.id).run();
    const requestCount = queries.length;
    await search.getByLabel("收件时间从", { exact: true }).fill("2026-10-31T00:00");
    await search.getByLabel("收件时间至", { exact: true }).fill("2026-10-29T00:00");
    await search.getByRole("button", { name: "搜索当前邮箱", exact: true }).click();
    await reader.getByRole("alert").filter({ hasText: "收件时间范围无效" }).waitFor();
    assert.equal(queries.length, requestCount);
    await search.getByRole("button", { name: "清除邮件筛选", exact: true }).click();
    await reader.getByRole("status").filter({ hasText: "已加载 25 封缓存邮件" }).waitFor();
    await page.getByRole("button", { name: "暂停平台同步", exact: true }).click();
    await page.getByRole("button", { name: "恢复平台同步", exact: true }).waitFor();
    await search.getByLabel("搜索当前邮箱邮件", { exact: true }).fill("Memo 28");
    await search.getByRole("button", { name: "搜索当前邮箱", exact: true }).click();
    await reader.getByRole("status").filter({ hasText: "已加载 1 封缓存邮件" }).waitFor();
    assert.equal(await reader.getByRole("button", { name: "刷新收信", exact: true }).isDisabled(), true);
    assert.equal(f.calls.length, calls, "Cached search, pagination, validation and reset must not call providers");
    assert.equal((await h.request(`/api/v1/mailboxes/${box.id}`, { cookie: user.cookie })).body.mailbox.paused, true);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(t.errors, []); assert.deepEqual(t.external, []);
  } finally { await t.close(); }
});

test("Chrome: stale search and pagination never overwrite a new single-mailbox query; explicit sync retains filters", { timeout: 120000 }, async () => {
  const t = await fixture();
  try {
    const { page, f, box } = t, reader = page.getByRole("region", { name: "单邮箱收件箱", exact: true });
    const search = reader.getByRole("form", { name: "单邮箱邮件搜索", exact: true });
    async function submit(query) {
      await search.getByLabel("搜索当前邮箱邮件", { exact: true }).fill(query);
      await search.getByRole("button", { name: "搜索当前邮箱", exact: true }).click();
    }
    for (const pagination of [false, true]) {
      if (pagination) { await submit("Project"); await reader.getByRole("status").filter({ hasText: "已加载 25 封缓存邮件" }).waitFor(); }
      let enter, release;
      const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
      const match = url => url.searchParams.get("q") === "Project" && url.searchParams.has("cursor") === pagination;
      await page.route("**/api/v1/messages?**", async route => {
        if (!match(new URL(route.request().url()))) return route.continue();
        const response = await route.fetch(); enter(); await held; await route.fulfill({ response });
      });
      const stale = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/messages" && match(new URL(response.url())));
      try {
        if (pagination) await reader.getByRole("button", { name: "加载更多邮件", exact: true }).click(); else await submit("Project");
        await entered; await submit("Memo 28");
        await reader.getByRole("status").filter({ hasText: "已加载 1 封缓存邮件" }).waitFor();
      } finally { release(); }
      await stale;
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await reader.getByRole("button", { name: /^Memo / }).count(), 1);
      await reader.getByRole("button", { name: "Memo 28", exact: true }).waitFor();
      await page.unroute("**/api/v1/messages?**");
    }
    f.messages.set(box.address, [{ ...cfMail(box.address, 30, "Fresh sync"), subject: "Memo 28 new" }]);
    await reader.getByRole("button", { name: "刷新收信", exact: true }).click();
    await reader.getByRole("status").filter({ hasText: "本页读取 1 封" }).waitFor();
    await reader.getByRole("status").filter({ hasText: "已加载 2 封缓存邮件" }).waitFor();
    assert.equal(await search.getByLabel("搜索当前邮箱邮件", { exact: true }).inputValue(), "Memo 28");
    assert.equal(await reader.getByRole("button", { name: "Memo 28 new", exact: true }).count(), 1);
    assert.deepEqual(t.errors, []); assert.deepEqual(t.external, []);
  } finally { await t.close(); }
});
