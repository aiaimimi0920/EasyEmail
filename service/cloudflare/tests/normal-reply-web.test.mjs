import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { normalReplyFixture } from "./normal-reply-fixture.mjs";
import { PASSWORD } from "./runtime-harness.mjs";

const button = (root, name) => root.getByRole("button", { name, exact: true });
async function open(t, read = true) {
  const browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); page.setDefaultTimeout(10000);
  await page.goto(t.h.baseUrl.href); await page.getByLabel("用户名", { exact: true }).fill(t.alice.username);
  await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await button(page, "登录").click();
  await page.getByRole("navigation").getByRole("button", { name: "普通邮箱", exact: true }).click();
  const normal = page.getByRole("region", { name: "普通邮箱", exact: true }); await button(normal, "普通发信邮箱").click();
  if (read) await normal.getByRole("region", { name: "普通邮箱收件", exact: true }).getByRole("button", { name: "Reply acceptance", exact: true }).click();
  return { browser, page, normal, detail: normal.getByRole("region", { name: "普通邮件详情", exact: true }), send: normal.getByRole("region", { name: "普通邮箱发信", exact: true }) };
}

test("Chrome: ordinary reply previews raw target, saves/reopens source-bound draft and reconciles a lost send with its original key", { timeout: 90000 }, async () => {
  const t = await normalReplyFixture(true); let ui;
  try {
    await t.configure(); const source = await t.seed(); ui = await open(t); const { page, detail, send } = ui, posts = [], reads = [], errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await button(detail, "回复").click(); await send.getByText(`回复原邮件 ${source.id}`, { exact: true }).waitFor();
    assert.equal(await send.getByLabel("收件地址", { exact: true }).inputValue(), "support@example.test");
    assert.equal(await send.getByLabel("普通邮件主题", { exact: true }).inputValue(), "Re: Reply acceptance"); assert.equal(t.opens.length, 0);
    await send.getByLabel("普通邮件正文", { exact: true }).fill("网页回复正文"); await button(send, "保存普通邮箱云端草稿").click();
    await send.getByRole("status").filter({ hasText: "已保存到云端 · 版本 1" }).waitFor(); await button(send, "新建普通邮件").click();
    await send.getByRole("region", { name: "普通邮箱云端草稿", exact: true }).getByRole("button", { name: "Re: Reply acceptance", exact: true }).click();
    await send.getByText(`回复原邮件 ${source.id}`, { exact: true }).waitFor();
    await page.route(`**/api/v1/normal-accounts/${t.id}/send`, async route => {
      posts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() }); await route.fetch(); await route.abort("failed");
    });
    await page.route(`**/api/v1/normal-accounts/${t.id}/outgoing?requestKey=*`, route => { reads.push(route.request().url()); return route.continue(); });
    await button(send, "发送普通邮件").click(); await button(send, "核对原普通邮件发送").waitFor();
    await page.getByRole("navigation").getByRole("button", { name: "聚合收件箱", exact: true }).click();
    const inbox = page.getByRole("region", { name: "聚合邮件", exact: true }); await button(inbox, "Reply acceptance").click();
    await button(inbox.getByRole("region", { name: "普通邮件详情", exact: true }), "回复").click();
    await page.getByRole("alert").filter({ hasText: "请先处理普通邮箱的未决操作或未保存内容" }).waitFor();
    await page.getByRole("navigation").getByRole("button", { name: "普通邮箱", exact: true }).click(); await button(send, "核对原普通邮件发送").click();
    await send.getByRole("status").filter({ hasText: "此普通草稿已提交发送" }).waitFor();
    assert.equal(posts.length, 1); assert.equal(posts[0].body.replyToMessageId, source.id); assert.equal(posts[0].body.draftRevision, 1);
    assert.equal(reads.length, 1); assert.ok(reads[0].includes(posts[0].key)); assert.equal(t.messages.length, 1); assert.match(t.messages[0], /In-Reply-To: <original@example.test>/);
    assert.deepEqual(errors, []); assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } catch (error) { if (ui) console.error(await ui.page.locator("body").ariaSnapshot()); throw error; }
  finally { await ui?.browser.close(); await t.close(); }
});

for (const target of ["same-revision", "other-account"]) test(`Chrome: delayed ${target} reply cannot destroy an original send attempt`, { timeout: 90000 }, async () => {
  const t = await normalReplyFixture(true); let ui, release;
  try {
    await t.configure(); let accountId = t.id;
    if (target === "other-account") {
      accountId = crypto.randomUUID(); const created = await t.h.request(`/api/v1/normal-accounts/${accountId}`, { cookie: t.alice.cookie, method: "PUT",
        headers: { "idempotency-key": crypto.randomUUID() }, body: { expectedRevision: 0, emailAddress: "second@example.test", displayName: "Second", endpointId: "example", username: "Second", password: "Synthetic-second-password", enabled: false } });
      assert.equal(created.status, 201, created.text);
    }
    const source = await t.seed(undefined, accountId); ui = await open(t, false); const { page, send } = ui, posts = [];
    await send.getByLabel("普通邮件正文", { exact: true }).waitFor();
    let entered; const entering = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    await page.route(`**${source.path}/reply`, async route => { entered(); await gate; await route.continue(); });
    await page.getByRole("navigation").getByRole("button", { name: "聚合收件箱", exact: true }).click();
    const inbox = page.getByRole("region", { name: "聚合邮件", exact: true }); await button(inbox, "Reply acceptance").click();
    await button(inbox.getByRole("region", { name: "普通邮件详情", exact: true }), "回复").click(); await entering;
    await page.getByRole("navigation").getByRole("button", { name: "普通邮箱", exact: true }).click();
    await send.getByLabel("收件地址", { exact: true }).fill("receiver@example.test"); await send.getByLabel("普通邮件主题", { exact: true }).fill("原始未决邮件");
    await send.getByLabel("普通邮件正文", { exact: true }).fill("不得被回复预填覆盖");
    await page.route(`**/api/v1/normal-accounts/${t.id}/send`, async route => {
      posts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() }); await route.fetch(); await route.abort("failed");
    });
    await button(send, "发送普通邮件").click(); await button(send, "核对原普通邮件发送").waitFor();
    if (target === "same-revision") await t.h.db.prepare("UPDATE normal_accounts SET revision=2 WHERE id=?").bind(t.id).run();
    release(); await page.getByRole("alert").filter({ hasText: "请先处理普通邮箱的未决操作或未保存内容" }).waitFor();
    assert.equal(await send.getByLabel("普通邮件主题", { exact: true }).inputValue(), "原始未决邮件");
    assert.equal(await send.locator("code").first().textContent(), posts[0].key); await button(send, "核对原普通邮件发送").click();
    await send.getByRole("status").filter({ hasText: "服务器已接受" }).waitFor(); assert.equal(posts.length, 1); assert.equal(t.opens.length, 1);
    assert.equal(await send.getByText(/^回复原邮件 /).count(), 0);
  } catch (error) { if (ui) console.error(await ui.page.locator("body").ariaSnapshot()); throw error; }
  finally { release?.(); await ui?.browser.close(); await t.close(); }
});

test("Chrome: dirty IMAP/SMTP/composer reject replies and manual switching without discarding input", { timeout: 90000 }, async () => {
  const t = await normalReplyFixture(true); let ui;
  try {
    await t.configure(); await t.seed(); ui = await open(t); const { page, normal, send } = ui;
    let previews = 0; page.on("request", req => { if (req.url().endsWith("/reply")) previews++; });
    for (const [label, changed] of [["IMAP 用户名", "Unsaved IMAP"], ["SMTP 用户名", "Unsaved SMTP"], ["普通邮件主题", "Unsaved message"]]) {
      await normal.getByLabel(label, { exact: true }).fill(changed);
      await page.waitForFunction(() => [...document.querySelectorAll("button")].some(b => b.textContent === "添加普通邮箱" && b.disabled));
      assert.equal(await button(normal, "添加普通邮箱").isDisabled(), true);
      await page.getByRole("navigation").getByRole("button", { name: "聚合收件箱", exact: true }).click();
      const inbox = page.getByRole("region", { name: "聚合邮件", exact: true }); await button(inbox, "Reply acceptance").click();
      await button(inbox.getByRole("region", { name: "普通邮件详情", exact: true }), "回复").click();
      await page.getByRole("alert").filter({ hasText: "请先处理普通邮箱的未决操作或未保存内容" }).waitFor();
      await page.getByRole("navigation").getByRole("button", { name: "普通邮箱", exact: true }).click();
      assert.equal(await normal.getByLabel(label, { exact: true }).inputValue(), changed);
      if (label === "IMAP 用户名") {
        await page.reload(); await page.getByRole("navigation").getByRole("button", { name: "普通邮箱", exact: true }).click(); await button(normal, "普通发信邮箱").click();
      } else if (label === "SMTP 用户名") {
        page.once("dialog", d => d.accept()); await button(normal, "刷新 SMTP 配置").click();
        await page.waitForFunction(() => document.querySelector('input') && [...document.querySelectorAll("input")].some(i => i.value === "Alice"));
        await send.getByLabel("普通邮件主题", { exact: true }).waitFor();
      }
    }
    assert.equal(previews, 0); assert.equal(t.opens.length, 0);
  } catch (error) { if (ui) console.error(await ui.page.locator("body").ariaSnapshot()); throw error; }
  finally { await ui?.browser.close(); await t.close(); }
});

test("Chrome: logout aborts a late reply preview and cannot navigate a different user to ordinary mail", { timeout: 90000 }, async () => {
  const t = await normalReplyFixture(true); let ui, release;
  try {
    await t.configure(); await t.seed(); const bob = await t.h.register("reply-new-browser-user"); ui = await open(t); const { page, detail } = ui;
    let entered, done; const entering = new Promise(resolve => { entered = resolve; }), finished = new Promise(resolve => { done = resolve; }), gate = new Promise(resolve => { release = resolve; });
    await page.route("**/messages/*/reply", async route => {
      try { const response = await route.fetch(); entered(); await gate; await route.fulfill({ response }); }
      catch { await route.abort().catch(() => {}); } finally { done(); }
    });
    await button(detail, "回复").click(); await entering; await button(page, "退出登录").click();
    await page.getByLabel("用户名", { exact: true }).fill(bob.username); await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await button(page, "登录").click();
    await page.getByRole("navigation").waitFor(); release(); await finished;
    assert.equal(await page.getByRole("navigation").getByRole("button", { name: "邮箱管理", exact: true }).getAttribute("aria-pressed"), "true");
    await page.getByRole("navigation").getByRole("button", { name: "普通邮箱", exact: true }).click(); await page.getByText("暂无普通邮箱", { exact: true }).waitFor();
    assert.equal(await page.getByText(/^回复原邮件 /).count(), 0); assert.equal(t.opens.length, 0);
  } finally { release?.(); await ui?.browser.close(); await t.close(); }
});
