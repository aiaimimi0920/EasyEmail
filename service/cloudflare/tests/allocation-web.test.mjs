import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { retentionWebFixture } from "./retention-web-fixture.mjs";
import { creationCalls } from "./allocation-fixture.mjs";

test("Chrome: automatic allocation is explicit, supports a domain filter, shows actual providers and stays isolated on mobile", { timeout: 90000 }, async () => {
  const a = await retentionWebFixture(), { h, page, admin, alice, f } = a;
  try {
    await a.login(page, admin.username);
    await page.getByRole("combobox", { name: "分配方式", exact: true }).selectOption("automatic");
    assert.equal(f.calls.length, 0, "Selecting automatic mode does not probe or allocate");
    const make = async () => {
      const response = page.waitForResponse((res) => res.url().endsWith("/api/v1/mailboxes") && res.request().method() === "POST");
      await page.getByRole("button", { name: "自动分配邮箱", exact: true }).click();
      const result = await response; assert.equal(result.status(), 201); return result.json();
    };
    const first = (await make()).mailbox; assert.equal(first.providerId, "self");
    await page.getByRole("button", { name: first.address, exact: true }).waitFor();
    await page.getByLabel("自动分配域名（可选）", { exact: true }).fill("temp.example.test");
    const second = (await make()).mailbox; assert.equal(second.providerId, "temporam");
    await page.getByRole("button", { name: second.address, exact: true }).waitFor();
    assert.equal(creationCalls(f).length, 1);
    assert.equal((await h.request("/api/v1/mailboxes", { cookie: alice.cookie })).body.items.length, 0);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(h.directory, "allocation-mobile.png"), fullPage: true });
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.deepEqual(a.errors, []); assert.deepEqual(a.external, []);
    console.log(`M3g Chrome evidence: ${h.directory}`);
  } catch (error) { console.error(await page.locator("body").ariaSnapshot()); throw error; }
  finally { await a.close(); }
});

test("Chrome: lost automatic success keeps one key and checks the same mailbox across navigation even when all providers are disabled", { timeout: 90000 }, async () => {
  const a = await retentionWebFixture(), { h, page, admin, f } = a;
  try {
    await a.login(page, admin.username);
    await page.getByRole("combobox", { name: "分配方式", exact: true }).selectOption("automatic");
    const keys = [];
    await page.route("**/api/v1/mailboxes", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      keys.push(route.request().headers()["idempotency-key"]);
      const response = await route.fetch();
      if (keys.length === 1) await route.abort("failed"); else await route.fulfill({ response });
    });
    await page.getByRole("button", { name: "自动分配邮箱", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "请检查本次创建结果" }).waitFor();
    assert.equal(await page.getByRole("combobox", { name: "分配方式", exact: true }).isDisabled(), true);
    const rows = (await h.request("/api/v1/admin/providers", { cookie: admin.cookie })).body.items;
    for (const row of rows) assert.equal((await h.request(`/api/v1/admin/providers/${row.config.id}`, {
      cookie: admin.cookie, method: "PUT", body: { expectedRevision: row.revision, config: { ...row.config, enabled: false }, secretAction: "keep" },
    })).status, 200);
    await page.getByRole("button", { name: "聚合收件箱", exact: true }).click();
    await page.getByRole("button", { name: "邮箱管理", exact: true }).click();
    const response = page.waitForResponse((res) => res.url().endsWith("/api/v1/mailboxes") && res.request().method() === "POST");
    await page.getByRole("button", { name: "检查创建结果", exact: true }).click();
    const checked = await response; assert.equal(checked.status(), 200);
    assert.equal((await checked.json()).mailbox.providerId, "self");
    assert.deepEqual(keys, [keys[0], keys[0]]); assert.ok(keys[0]);
    assert.equal(creationCalls(f).length, 1); assert.equal(f.calls.some((call) => call.path.startsWith("/v3")), false);
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM mailbox_creations").first()).n, 1);
    assert.deepEqual(a.errors, []); assert.deepEqual(a.external, []);
  } catch (error) { console.error(await page.locator("body").ariaSnapshot()); throw error; }
  finally { await a.close(); }
});

test("Chrome: cooling is visible to users and administrators, explicit probe recovery does not retry an unknown creation", { timeout: 90000 }, async () => {
  const a = await retentionWebFixture(), { h, page, admin, f } = a;
  try {
    await a.login(page, admin.username);
    f.modes.set("/cf/admin/new_address", "invalid");
    await page.getByRole("combobox", { name: "分配方式", exact: true }).selectOption("automatic");
    await page.getByRole("button", { name: "自动分配邮箱", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "创建结果待确认：unknown · self" }).waitFor();
    const unknown = (await h.db.prepare("SELECT * FROM mailbox_creations").all()).results[0];
    await page.getByRole("button", { name: "平台管理", exact: true }).click();
    await page.getByText(/新分配：冷却至/).waitFor();
    await page.getByText(/分配错误：provider_invalid_response/).waitFor();
    f.modes.clear(); await page.getByRole("button", { name: "探测 self", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "self：接口探测通过" }).waitFor();
    assert.equal((await h.db.prepare("SELECT cooldown_until FROM provider_allocation_state WHERE provider_id='self'").first()).cooldown_until, null);
    await page.getByRole("button", { name: "邮箱管理", exact: true }).click();
    await page.getByRole("button", { name: "检查创建结果", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "创建结果待确认：unknown · self" }).waitFor();
    assert.equal(creationCalls(f).length, 1);
    assert.equal((await h.db.prepare("SELECT request_key FROM mailbox_creations").first()).request_key, unknown.request_key);
    assert.deepEqual(a.errors, []); assert.deepEqual(a.external, []);
  } catch (error) { console.error(await page.locator("body").ariaSnapshot()); throw error; }
  finally { await a.close(); }
});
