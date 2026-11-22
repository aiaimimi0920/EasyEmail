import assert from "node:assert/strict";
import { test } from "node:test";
import { retentionWebFixture } from "./retention-web-fixture.mjs";
import { allocate } from "./provider-fixture.mjs";
import { ok } from "./admin-fixture.mjs";
import { creationCalls } from "./allocation-fixture.mjs";

test("Chrome: delayed workspace refresh disables cached actions and opening a mailbox always reads its current expiry", { timeout: 90000 }, async () => {
  const a = await retentionWebFixture(), { h, page, admin, f } = a;
  let release = () => {};
  try {
    const box = ok(await allocate(h, admin.cookie), 201).mailbox;
    await a.login(page, admin.username);
    await page.getByRole("button", { name: box.address, exact: true }).click();
    await page.getByRole("button", { name: "刷新收信", exact: true }).waitFor();
    await page.getByRole("button", { name: "平台管理", exact: true }).click();
    await h.db.prepare("UPDATE mailboxes SET expires_at=unixepoch()-1 WHERE id=?").bind(box.id).run();
    let entered;
    const reached = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    await page.route("**/api/v1/mailboxes", async (route) => { entered(); await gate; await route.continue(); });
    await page.getByRole("button", { name: "邮箱管理", exact: true }).click(); await reached;
    await page.waitForFunction((address) => [...document.querySelectorAll("button")].some((button) => button.textContent === address && button.disabled), box.address);
    assert.equal(await page.getByRole("button", { name: box.address, exact: true }).isDisabled(), true);
    for (const name of ["用此邮箱写信", "刷新收信", "停用邮箱"]) assert.equal(await page.getByRole("button", { name, exact: true }).isDisabled(), true, name);
    const fresh = page.waitForResponse((res) => res.url().endsWith("/api/v1/mailboxes") && res.request().method() === "GET");
    release(); await fresh;
    await page.waitForFunction((address) => [...document.querySelectorAll("button")].some((button) => button.textContent === address && !button.disabled), box.address);
    assert.equal(await page.getByRole("button", { name: "用此邮箱写信", exact: true }).isDisabled(), true);
    await page.unroute("**/api/v1/mailboxes");
    await h.db.prepare("UPDATE mailboxes SET expires_at=unixepoch()+86400 WHERE id=?").bind(box.id).run();
    const detail = page.waitForResponse((res) => res.url().endsWith(`/api/v1/mailboxes/${box.id}`));
    await page.getByRole("button", { name: box.address, exact: true }).click();
    assert.equal((await detail).status(), 200);
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent === "用此邮箱写信" && !button.disabled && !button.closest("fieldset")?.disabled));
    assert.equal(await page.getByRole("button", { name: "用此邮箱写信", exact: true }).isDisabled(), false);
    const refreshed = page.waitForResponse((res) => res.url().endsWith("/api/v1/mailboxes") && res.request().method() === "GET");
    await page.getByRole("button", { name: "刷新供应商状态", exact: true }).click(); await refreshed;
    assert.equal(creationCalls(f).length, 1);
    assert.deepEqual(a.errors, []); assert.deepEqual(a.external, []);
  } catch (error) { console.error(await page.locator("body").ariaSnapshot()); throw error; }
  finally { release(); await a.close(); }
});
