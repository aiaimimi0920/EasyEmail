import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { retentionWebFixture } from "./retention-web-fixture.mjs";
import { automatic, creationCalls } from "./allocation-fixture.mjs";

test("Chrome: unknown creation survives reload, requires explicit risk confirmation, and stays unknown when a new allocation succeeds", { timeout: 90000 }, async () => {
  const a = await retentionWebFixture(), { h, page, admin, f } = a;
  try {
    await a.login(page, admin.username);
    await page.getByRole("combobox", { name: "分配方式", exact: true }).selectOption("automatic");
    f.modes.set("/cf/admin/new_address", "invalid");
    await page.getByRole("button", { name: "自动分配邮箱", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "创建结果待确认：unknown" }).waitFor();
    const original = (await h.db.prepare("SELECT * FROM mailbox_creations").all()).results[0];
    const calls = creationCalls(f).length;
    await page.reload();
    await page.getByRole("status").filter({ hasText: "创建结果待确认：unknown" }).waitFor();
    assert.equal(await page.getByRole("combobox", { name: "分配方式", exact: true }).isDisabled(), true);
    const check = page.waitForResponse((res) => res.url().endsWith(`/mailbox-creations/${original.mailbox_id}`) && res.request().method() === "GET");
    await page.getByRole("button", { name: "检查创建结果", exact: true }).click(); await check;
    const confirmation = page.getByRole("form", { name: "未决创建确认", exact: true });
    const next = confirmation.getByRole("button", { name: "保留未决记录，另起分配", exact: true });
    assert.equal(await next.isDisabled(), true);
    await confirmation.getByLabel("确认原邮箱地址", { exact: true }).fill(original.address);
    assert.equal(await next.isDisabled(), true);
    await confirmation.getByRole("checkbox").check();
    const acknowledgement = page.waitForResponse((res) => res.url().endsWith(`/mailbox-creations/${original.mailbox_id}/acknowledge`));
    await next.click(); assert.equal((await acknowledgement).status(), 200);
    assert.equal(creationCalls(f).length, calls);
    await page.getByRole("combobox", { name: "分配方式", exact: true }).selectOption("automatic");
    const allocated = page.waitForResponse((res) => res.url().endsWith("/api/v1/mailboxes") && res.request().method() === "POST");
    await page.getByRole("button", { name: "自动分配邮箱", exact: true }).click();
    const newBox = (await (await allocated).json()).mailbox;
    assert.equal(newBox.providerId, "temporam"); assert.notEqual(newBox.id, original.mailbox_id);
    await page.getByRole("button", { name: newBox.address, exact: true }).waitFor();
    await page.reload();
    await page.getByRole("region", { name: "创建历史", exact: true }).getByText("已知悉不确定性：", { exact: false }).waitFor();
    const rows = (await h.db.prepare("SELECT * FROM mailbox_creations").all()).results;
    assert.equal(rows.length, 2); assert.equal(rows.find((row) => row.mailbox_id === original.mailbox_id).state, "unknown");
    assert.equal(creationCalls(f).length, 1);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(h.directory, "creation-history-mobile.png"), fullPage: true });
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.deepEqual(a.errors, []); assert.deepEqual(a.external, []);
    console.log(`M3h Chrome evidence: ${h.directory}`);
  } catch (error) { console.error(await page.locator("body").ariaSnapshot()); throw error; }
  finally { await a.close(); }
});

test("Chrome: an acknowledged pending request can finish later and history opens its actual mailbox without recreating it", { timeout: 90000 }, async () => {
  const a = await retentionWebFixture(), { h, page, admin, alice, f } = a;
  let gate;
  try {
    gate = f.hold("/cf/admin/new_address"); const creating = automatic(h, admin.cookie);
    await gate.entered;
    const row = (await h.db.prepare("SELECT * FROM mailbox_creations").all()).results[0];
    await a.login(page, admin.username);
    await page.getByRole("status").filter({ hasText: "创建结果待确认：pending" }).waitFor();
    await page.getByLabel("确认原邮箱地址", { exact: true }).fill(row.address);
    await page.getByRole("form", { name: "未决创建确认", exact: true }).getByRole("checkbox").check();
    await page.getByRole("button", { name: "保留未决记录，另起分配", exact: true }).click();
    gate.release(); assert.equal((await creating).status, 201);
    await page.getByRole("button", { name: "刷新供应商状态", exact: true }).click();
    const history = page.getByRole("region", { name: "创建历史", exact: true });
    await history.getByText(/已创建 · self/).waitFor();
    await history.getByRole("button", { name: `查看创建 ${row.mailbox_id}`, exact: true }).click();
    await page.getByRole("button", { name: "用此邮箱写信", exact: true }).waitFor();
    assert.equal(creationCalls(f).length, 1);
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await a.login(page, alice.username);
    await page.getByRole("region", { name: "创建历史", exact: true }).getByText("暂无创建记录", { exact: true }).waitFor();
    assert.equal(await page.getByText(row.address, { exact: true }).count(), 0);
    assert.deepEqual(a.errors, []); assert.deepEqual(a.external, []);
  } catch (error) { console.error(await page.locator("body").ariaSnapshot()); throw error; }
  finally { gate?.release(); await a.close(); }
});

test("Chrome: history failure blocks fresh allocation until recovery, including an unresolved record older than the first history page", { timeout: 90000 }, async () => {
  const a = await retentionWebFixture(), { h, page, admin, f } = a;
  try {
    f.modes.set("/cf/admin/new_address", "invalid");
    const unknown = (await automatic(h, admin.cookie)).body.creation;
    await h.db.prepare("UPDATE mailbox_creations SET created_at=1 WHERE mailbox_id=?").bind(unknown.mailboxId).run();
    for (let index = 0; index < 26; index++) await h.db.prepare(`INSERT INTO mailbox_creations
      (user_id,request_key,request_hash,mailbox_id,address,state,created_at) VALUES (?,?,?,?,?,'complete',?)`)
      .bind(admin.id, crypto.randomUUID(), "synthetic-history-only", crypto.randomUUID(), `history-${index}@cf.example.test`, 200 + index).run();
    await page.route("**/api/v1/mailbox-creations*", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":{"code":"request_failed"}}' }));
    await a.login(page, admin.username);
    const history = page.getByRole("region", { name: "创建历史", exact: true });
    await history.getByRole("alert").waitFor();
    assert.equal(await page.getByRole("button", { name: "分配随机邮箱", exact: true }).isDisabled(), true);
    assert.equal(creationCalls(f).length, 1);
    await page.unroute("**/api/v1/mailbox-creations*");
    await page.getByRole("button", { name: "刷新供应商状态", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "创建结果待确认：unknown" }).waitFor();
    assert.equal(await history.getByRole("button", { name: `查看创建 ${unknown.mailboxId}`, exact: true }).count(), 0);
    assert.equal(await history.getByRole("button").first().isDisabled(), true);
    await history.getByRole("button", { name: "加载更多创建记录", exact: true }).click();
    await history.getByRole("button", { name: `查看创建 ${unknown.mailboxId}`, exact: true }).waitFor();
    assert.equal(await history.getByRole("button", { name: /^查看创建 / }).count(), 27);
    assert.equal(await page.getByRole("combobox", { name: "分配方式", exact: true }).isDisabled(), true);
    await page.setViewportSize({ width: 390, height: 844 });
    const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      overflow: [...document.querySelectorAll("main *")].filter((element) => element.getBoundingClientRect().right > innerWidth || element.scrollWidth > element.clientWidth + 1)
        .slice(0, 8).map((element) => ({ tag: element.tagName, role: element.getAttribute("role"), text: element.textContent.slice(0, 120) })) }));
    assert.ok(layout.scrollWidth <= layout.width, JSON.stringify(layout));
    await page.getByRole("form", { name: "未决创建确认", exact: true }).screenshot({ path: path.join(h.directory, "creation-confirmation-mobile.png") });
    assert.equal(creationCalls(f).length, 1);
    assert.deepEqual(a.errors, []); assert.deepEqual(a.external, []);
    console.log(`M3h confirmation evidence: ${h.directory}`);
  } catch (error) { console.error(await page.locator("body").ariaSnapshot()); throw error; }
  finally { await a.close(); }
});
