import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import { mailboxDeleteFixture } from './mailbox-delete-fixture.mjs';
import { PASSWORD } from './runtime-harness.mjs';

async function setup(remoteOptions = {}) {
  const t = await mailboxDeleteFixture(true, null, remoteOptions); let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); page.setDefaultTimeout(10000);
    const errors = [], external = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => { if (!request.url().startsWith(t.h.baseUrl.origin)) external.push(request.url()); });
    await page.goto(t.h.baseUrl.href);
    await page.getByLabel('用户名', { exact: true }).fill(t.alice.username); await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('combobox', { name: '命名方式', exact: true }).selectOption('custom');
    return { ...t, page, errors, external,
      writes: () => t.f.calls.filter((call) => call.path === '/cf/admin/custom_address' && call.method === 'POST'),
      async create() {
        const pending = page.waitForResponse((res) => res.url().endsWith('/api/v1/mailboxes') && res.request().method() === 'POST');
        await page.getByRole('button', { name: '创建自定义邮箱', exact: true }).click(); return pending;
      },
      async close() { await browser.close(); await t.close(); } };
  } catch (error) { await browser?.close(); await t.close(); throw error; }
}

test('Chrome: exact custom address, invalid input, persistent unknown and read-only recovery reuse the existing creation guard', { timeout: 90000 }, async () => {
  const t = await setup(), { page } = t;
  try {
    await page.getByRole('combobox', { name: '域名', exact: true }).selectOption('cf.example.test');
    await page.getByLabel('邮箱前缀', { exact: true }).fill('Upper');
    assert.equal(await page.getByRole('button', { name: '创建自定义邮箱', exact: true }).isDisabled(), true);
    assert.equal(t.writes().length, 0);
    await page.getByLabel('邮箱前缀', { exact: true }).fill('webchosen');
    const response = await t.create(); assert.equal(response.status(), 201);
    const box = (await response.json()).mailbox; assert.equal(box.address, 'webchosen@cf.example.test');
    await page.getByRole('heading', { name: '收件箱', exact: true }).waitFor();
    await page.getByRole('button', { name: '邮箱管理', exact: true }).click();
    await page.getByLabel('邮箱前缀', { exact: true }).fill('weblost');
    t.f.modes.set('/cf/admin/custom_address', 'lose-response');
    assert.equal((await t.create()).status(), 202);
    await page.getByRole('status').filter({ hasText: '创建结果待确认：unknown' }).waitFor();
    assert.equal(await page.getByRole('combobox', { name: '命名方式', exact: true }).isDisabled(), true);
    assert.equal(await page.getByLabel('邮箱前缀', { exact: true }).isDisabled(), true);
    const row = await t.h.db.prepare("SELECT * FROM mailbox_creations WHERE state='unknown'").first();
    await page.reload(); await page.getByRole('status').filter({ hasText: 'weblost@cf.example.test' }).waitFor();
    const checked = page.waitForResponse((res) => res.url().endsWith(`/mailbox-creations/${row.mailbox_id}`) && res.request().method() === 'GET');
    await page.getByRole('button', { name: '检查创建结果', exact: true }).click(); assert.equal((await checked).status(), 200);
    assert.equal(t.writes().length, 2); assert.equal(t.f.calls.some((call) => call.path === '/cf/admin/new_address'), false);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(t.h.directory, 'custom-prefix-mobile.png'), fullPage: true });
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.deepEqual(t.errors, []); assert.deepEqual(t.external, []);
    console.log(`Custom prefix Chrome evidence: ${t.h.directory}`);
  } catch (error) { console.error(await page.locator('body').ariaSnapshot()); throw error; }
  finally { await t.close(); }
});

test('Chrome: automatic selection supports custom names without silently choosing random allocation', { timeout: 90000 }, async () => {
  const t = await setup(), { page } = t;
  try {
    await page.getByRole('combobox', { name: '分配方式', exact: true }).selectOption('automatic');
    await page.getByLabel('邮箱前缀', { exact: true }).fill('autoemail');
    await page.getByLabel('自动分配域名（可选）', { exact: true }).fill('cf.example.test');
    const response = await t.create(); assert.equal(response.status(), 201);
    assert.equal((await response.json()).mailbox.address, 'autoemail@cf.example.test'); assert.equal(t.writes().length, 1);
    assert.deepEqual(t.errors, []); assert.deepEqual(t.external, []);
  } finally { await t.close(); }
});

test('Chrome: real disabled capability blocks custom creation while random allocation remains available', { timeout: 90000 }, async () => {
  const t = await setup({ customBindings: { DISABLE_CUSTOM_ADDRESS_NAME: 'true' } }), { page } = t;
  try {
    await page.getByRole('status').filter({ hasText: '此供应商已关闭自定义前缀' }).waitFor();
    await page.getByLabel('邮箱前缀', { exact: true }).fill('notallowed');
    assert.equal(await page.getByRole('button', { name: '创建自定义邮箱', exact: true }).isDisabled(), true);
    assert.equal(t.writes().length, 0);
    await page.getByRole('combobox', { name: '命名方式', exact: true }).selectOption('random');
    await page.getByRole('combobox', { name: '域名', exact: true }).selectOption('cf.example.test');
    const response = page.waitForResponse((res) => res.url().endsWith('/api/v1/mailboxes') && res.request().method() === 'POST');
    await page.getByRole('button', { name: '分配随机邮箱', exact: true }).click(); assert.equal((await response).status(), 201);
    assert.equal(t.writes().length, 0); assert.deepEqual(t.errors, []); assert.deepEqual(t.external, []);
  } finally { await t.close(); }
});
