import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { ok } from "./admin-fixture.mjs";
import { allocate } from "./provider-fixture.mjs";
import { seedRetentionMessage } from "./retention-fixture.mjs";
import { sendRequest } from "./send-fixture.mjs";
import { retentionWebFixture } from "./retention-web-fixture.mjs";

test("Chrome: retention preview, cancellation, save, expiry, content redaction and restart preserve safe user boundaries", { timeout: 90000 }, async () => {
  const a = await retentionWebFixture(), { h, page, panel, admin, alice } = a;
  try {
    const box = ok(await allocate(h, admin.cookie), 201).mailbox;
    const message = await seedRetentionMessage(h, admin.id, box, { age: 0 });
    ok(await sendRequest(h, admin.cookie, box, crypto.randomUUID()), 201);
    await h.db.prepare("UPDATE outgoing_messages SET updated_at=unixepoch()-259200").run();
    await a.login(page, admin.username); await a.open();
    assert.equal(await panel.getByLabel("启用自动保留策略", { exact: true }).isChecked(), false);
    await panel.getByLabel("启用自动保留策略", { exact: true }).check();
    await panel.getByLabel("新邮箱平台期限（天）", { exact: true }).fill("1");
    await panel.getByLabel("发送内容保留（天）", { exact: true }).fill("1");
    const preview = await a.request("预览保留影响", "/admin/retention/preview", "POST");
    assert.equal(preview.preview.counts.redactedOutgoing, 1);
    assert.equal((await h.db.prepare("SELECT revision FROM retention_policy").first()).revision, 0);
    assert.equal((await h.db.prepare("SELECT content_purged_at FROM outgoing_messages").first()).content_purged_at, null);
    page.once("dialog", (dialog) => dialog.dismiss());
    await panel.getByRole("button", { name: "保存保留策略", exact: true }).click();
    assert.equal((await h.db.prepare("SELECT revision FROM retention_policy").first()).revision, 0);
    page.once("dialog", (dialog) => dialog.accept());
    await a.request("保存保留策略", "/admin/retention", "PUT");
    await panel.getByRole("status").filter({ hasText: "保留策略已保存" }).waitFor();
    const next = ok(await allocate(h, admin.cookie), 201).mailbox; assert.ok(next.expiresAt);
    await h.db.prepare("UPDATE mailboxes SET expires_at=unixepoch()-1 WHERE id=?").bind(box.id).run();
    await a.request("预览保留影响", "/admin/retention/preview", "POST");
    page.once("dialog", (dialog) => dialog.dismiss());
    await panel.getByRole("button", { name: "执行一批维护", exact: true }).click();
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM retention_runs").first()).n, 0);
    page.once("dialog", (dialog) => dialog.accept());
    const result = await a.request("执行一批维护", "/admin/retention/run", "POST");
    assert.equal(result.run.counts.redactedOutgoing, 1); assert.equal(result.run.counts.expiredMailboxes, 1);
    await panel.getByRole("heading", { name: "最近维护结果", exact: true }).waitFor();
    await page.getByRole("button", { name: "邮箱管理", exact: true }).click();
    await page.getByRole("button", { name: box.address, exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "用此邮箱写信", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "刷新收信", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "停用邮箱", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "Synthetic retention subject", exact: true }).click();
    await page.getByText("Synthetic retention text", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "回复此邮件", exact: true }).count(), 0);
    assert.equal((await h.db.prepare("SELECT purged_at FROM messages WHERE id=?").bind(message).first()).purged_at, null);
    await page.getByRole("button", { name: "写信与发送记录", exact: true }).click();
    await page.getByRole("button", { name: "发送内容已清除", exact: true }).click();
    await page.getByText(/发送内容已按策略清除，防重放记录仍保留/).waitFor();
    await h.restart(); await page.reload(); await a.open();
    assert.equal(await panel.getByLabel("新邮箱平台期限（天）", { exact: true }).inputValue(), "1");
    await panel.getByRole("heading", { name: "最近维护结果", exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    await page.screenshot({ path: path.join(h.directory, "retention-mobile.png"), fullPage: true });
    const ordinary = await a.browser.newPage(); await a.login(ordinary, alice.username);
    assert.equal(await ordinary.getByRole("button", { name: "平台管理", exact: true }).count(), 0);
    assert.equal(await ordinary.getByRole("region", { name: "数据保留", exact: true }).count(), 0);
    assert.equal(await ordinary.evaluate(async () => (await fetch("/api/v1/admin/retention")).status), 403);
    assert.deepEqual(a.errors, []); assert.deepEqual(a.external, []);
    console.log(`M3f Chrome lifecycle evidence: ${h.directory}`);
  } catch (error) { console.error(await page.locator("body").ariaSnapshot()); throw error; }
  finally { await a.close(); }
});

test("Chrome: an unknown maintenance response keeps the original key across workspace navigation and checks, not reruns, its batch", { timeout: 90000 }, async () => {
  const a = await retentionWebFixture(), { h, page, panel, admin } = a;
  try {
    const box = ok(await allocate(h, admin.cookie), 201).mailbox;
    await seedRetentionMessage(h, admin.id, box);
    await a.login(page, admin.username); await a.open();
    await panel.getByLabel("启用自动保留策略", { exact: true }).check();
    await panel.getByLabel("缓存保留（天）", { exact: true }).fill("1");
    await a.request("预览保留影响", "/admin/retention/preview", "POST");
    page.once("dialog", (dialog) => dialog.accept()); await a.request("保存保留策略", "/admin/retention", "PUT");
    await panel.getByRole("status").filter({ hasText: "保留策略已保存" }).waitFor();
    await a.request("预览保留影响", "/admin/retention/preview", "POST");
    const keys = [];
    await page.route("**/admin/retention/run", async (route) => {
      keys.push(route.request().headers()["idempotency-key"]);
      const response = await route.fetch();
      if (keys.length === 1) await route.abort("failed"); else await route.fulfill({ response });
    });
    page.once("dialog", (dialog) => dialog.accept());
    await panel.getByRole("button", { name: "执行一批维护", exact: true }).click();
    await panel.getByRole("status").filter({ hasText: "维护结果待确认" }).waitFor();
    const key = await page.getByTestId("retention-attempt-key").innerText(); assert.equal(key, keys[0]);
    const preserved = await seedRetentionMessage(h, admin.id, box);
    await page.getByRole("button", { name: "聚合收件箱", exact: true }).click();
    await page.getByRole("button", { name: "平台管理", exact: true }).click();
    assert.equal(await page.getByTestId("retention-attempt-key").innerText(), key);
    assert.equal(await panel.getByRole("button", { name: "刷新保留策略", exact: true }).isDisabled(), true);
    const checked = await a.request("检查维护结果", "/admin/retention/run", "POST");
    assert.equal(checked.replayed, true); assert.deepEqual(keys, [key, key]);
    await panel.getByRole("status").filter({ hasText: "未再执行一批" }).waitFor();
    assert.equal((await h.db.prepare("SELECT purged_at FROM messages WHERE id=?").bind(preserved).first()).purged_at, null);
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM retention_runs").first()).n, 1);
    assert.equal(await page.getByTestId("retention-attempt-key").count(), 0);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.deepEqual(a.errors, []); assert.deepEqual(a.external, []);
    console.log(`M3f Chrome retry evidence: ${h.directory}`);
  } catch (error) { console.error(await page.locator("body").ariaSnapshot()); throw error; }
  finally { await a.close(); }
});

test("Chrome: open mailbox actions expire with time and stale retention edits cannot overwrite a concurrent policy", { timeout: 90000 }, async () => {
  const a = await retentionWebFixture(), { h, page, panel, admin } = a;
  try {
    const box = ok(await allocate(h, admin.cookie), 201).mailbox;
    await a.login(page, admin.username);
    await h.db.prepare("UPDATE mailboxes SET expires_at=unixepoch()+5 WHERE id=?").bind(box.id).run();
    await page.reload();
    await page.getByRole("button", { name: box.address, exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "用此邮箱写信", exact: true }).isDisabled(), false);
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent === "用此邮箱写信" && button.disabled));
    assert.equal(await page.getByRole("button", { name: "刷新收信", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "停用邮箱", exact: true }).isDisabled(), true);
    await a.open();
    await panel.getByLabel("启用自动保留策略", { exact: true }).check();
    await panel.getByLabel("缓存保留（天）", { exact: true }).fill("7");
    await a.request("预览保留影响", "/admin/retention/preview", "POST");
    const initial = ok(await h.request("/api/v1/admin/retention", { cookie: admin.cookie }));
    ok(await h.request("/api/v1/admin/retention", { cookie: admin.cookie, method: "PUT", body: {
      expectedRevision: initial.revision, policy: { ...initial.policy, enabled: true, cacheDays: 30 }, confirm: "APPLY RETENTION" } }));
    const response = page.waitForResponse((res) => res.url().endsWith("/admin/retention") && res.request().method() === "PUT");
    page.once("dialog", (dialog) => dialog.accept());
    await panel.getByRole("button", { name: "保存保留策略", exact: true }).click();
    assert.equal((await response).status(), 409);
    await panel.getByRole("alert").filter({ hasText: "保留策略已变化" }).waitFor();
    const current = ok(await h.request("/api/v1/admin/retention", { cookie: admin.cookie }));
    assert.equal(current.revision, 1); assert.equal(current.policy.cacheDays, 30);
    await a.request("刷新保留策略", "/admin/retention", "GET");
    await page.waitForFunction(() => [...document.querySelectorAll("input")].some((input) => input.type === "number" && input.value === "30"));
    assert.equal(await panel.getByRole("button", { name: "执行一批维护", exact: true }).isDisabled(), true);
    assert.deepEqual(a.errors, []); assert.deepEqual(a.external, []);
  } catch (error) { console.error(await page.locator("body").ariaSnapshot()); throw error; }
  finally { await a.close(); }
});
