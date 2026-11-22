import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import { mailboxAccessFixture, assertReadOnlyProof } from './mailbox-access-fixture.mjs';
import { PASSWORD } from './runtime-harness.mjs';

async function web(t) {
  const browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH
    ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  let page;
  try {
    const context = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
    page = await context.newPage(); const errors = [], external = [];
    page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (!request.url().startsWith(t.h.baseUrl.origin)) external.push(request.url()); });
    await page.goto(t.h.baseUrl.href);
    await page.getByLabel('用户名', { exact: true }).fill(t.alice.username);
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    const login = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/auth/login');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const authenticated = await login; assert.equal(authenticated.status(), 200, await authenticated.text());
    const region = page.getByRole('region', { name: '恢复已有临时邮箱', exact: true });
    await region.getByLabel('恢复供应商', { exact: true }).selectOption('self');
    return { browser, page, region, errors, external };
  } catch (error) {
    if (page) { console.error(await page.locator('body').ariaSnapshot()); await page.screenshot({ path: path.join(t.h.directory, 'recovery-login-failure.png'), fullPage: true }); }
    await browser.close(); throw error;
  }
}
async function fill(w, remote) {
  await w.region.getByLabel('已有邮箱地址', { exact: true }).fill(remote.address);
  await w.region.getByLabel('邮箱访问凭据', { exact: true }).fill(remote.jwt);
}
const submit = w => w.region.getByRole('button', { name: '验证并恢复访问', exact: true }).click();

test('Chrome: import, release, proof recovery and key-only reload reconciliation preserve current lifecycle', { timeout: 120000 }, async () => {
  const t = await mailboxAccessFixture(true); let w;
  try {
    w = await web(t); const remote = await t.upstream.create(); await fill(w, remote);
    const response = w.page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/mailbox-access-recoveries' && r.request().method() === 'POST');
    await submit(w); const imported = await (await response).json(), key = imported.recovery.requestKey, id = imported.recovery.mailboxId;
    await w.region.getByRole('status').filter({ hasText: '已导入邮箱访问' }).waitFor();
    assert.equal(await w.region.getByLabel('邮箱访问凭据', { exact: true }).inputValue(), '');
    await w.page.getByRole('heading', { name: '收件箱', exact: true }).waitFor();
    await w.page.getByRole('button', { name: '释放平台访问', exact: true }).click();
    await w.page.getByLabel('确认释放的邮箱地址', { exact: true }).fill(remote.address);
    await w.page.getByRole('button', { name: '确认释放平台访问', exact: true }).click();
    await w.page.getByRole('status').filter({ hasText: '已释放平台访问；历史缓存保留' }).waitFor();
    await fill(w, remote); await submit(w);
    await w.region.getByRole('status').filter({ hasText: '访问凭据已恢复' }).waitFor();
    await w.page.getByRole('button', { name: '启用邮箱', exact: true }).waitFor();
    assert.equal(await w.page.getByRole('button', { name: '刷新收信', exact: true }).isDisabled(), true);
    const stored = await t.h.db.prepare('SELECT * FROM mailboxes WHERE id=?').bind(id).first();
    assert.equal(stored.released_at, null); assert.ok(stored.disabled_at); assert.ok(stored.credential_cipher);
    await t.h.request(`/api/v1/mailboxes/${id}/lifecycle`, { method: 'POST', cookie: t.alice.cookie,
      body: { action: 'release', confirmAddress: remote.address } });
    const released = await t.h.db.prepare('SELECT * FROM mailboxes WHERE id=?').bind(id).first();
    await w.page.reload();
    await w.region.getByLabel('已有恢复请求键', { exact: true }).fill(key);
    await w.region.getByRole('button', { name: '只读核对已有恢复', exact: true }).click();
    await w.region.getByRole('status').filter({ hasText: '已核对原恢复回执' }).waitFor();
    await w.page.getByRole('status').filter({ hasText: '已释放平台访问；历史缓存保留' }).waitFor();
    assert.deepEqual(await t.h.db.prepare('SELECT * FROM mailboxes WHERE id=?').bind(id).first(), released);
    assertReadOnlyProof(t, 2);
    await w.page.setViewportSize({ width: 390, height: 844 });
    await w.page.screenshot({ path: path.join(t.h.directory, 'mailbox-access-mobile.png'), fullPage: true });
    const overflow = await w.page.evaluate(() => [...document.querySelectorAll('main *')].filter(element => element.getBoundingClientRect().right > innerWidth + 1)
      .map(element => ({ tag: element.tagName, class: element.className, width: element.getBoundingClientRect().width, text: element.textContent?.slice(0, 120) })));
    assert.equal(await w.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, JSON.stringify(overflow));
    assert.equal(await w.page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.deepEqual(w.errors, []); assert.deepEqual(w.external, []); console.log(`Recovery Chrome evidence: ${t.h.directory}`);
  } finally { await w?.browser.close(); await t.close(); }
});

test('Chrome: response loss and mismatched receipts retain the original request and only GET reconciliation unlocks it', { timeout: 120000 }, async () => {
  const t = await mailboxAccessFixture(true); let w;
  try {
    w = await web(t); const remote = await t.upstream.create(); await fill(w, remote); let posts = 0;
    await w.page.route('**/api/v1/mailbox-access-recoveries', async route => {
      posts++; const response = await route.fetch(); await response.body(); await route.abort('failed');
    });
    await submit(w);
    await w.region.getByRole('alert').filter({ hasText: '请使用原请求键核对' }).waitFor();
    assert.equal(await w.region.getByRole('button', { name: '验证并恢复访问', exact: true }).isDisabled(), true);
    assert.equal(await w.region.getByLabel('邮箱访问凭据', { exact: true }).inputValue(), '');
    await w.page.getByRole('button', { name: '聚合收件箱', exact: true }).click();
    await w.page.getByRole('button', { name: '邮箱管理', exact: true }).click();
    assert.equal(posts, 1); assertReadOnlyProof(t, 1);
    await w.region.getByRole('button', { name: '核对原恢复结果', exact: true }).click();
    await w.region.getByRole('status').filter({ hasText: '已导入邮箱访问' }).waitFor(); assert.equal(posts, 1);
    await w.page.unroute('**/api/v1/mailbox-access-recoveries');
    const next = await t.upstream.create(); await fill(w, next);
    await w.page.route('**/api/v1/mailbox-access-recoveries', async route => {
      posts++; const response = await route.fetch(), body = await response.json(); body.recovery.address = 'wrong@example.test';
      await route.fulfill({ response, json: body });
    });
    await submit(w); await w.region.getByRole('alert').filter({ hasText: '恢复回执不匹配' }).waitFor();
    assert.equal(await w.region.getByRole('button', { name: '验证并恢复访问', exact: true }).isDisabled(), true);
    await w.region.getByRole('button', { name: '核对原恢复结果', exact: true }).click();
    await w.region.getByRole('status').filter({ hasText: '已导入邮箱访问' }).waitFor(); assert.equal(posts, 2); assertReadOnlyProof(t, 2);
    assert.equal(await w.page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.deepEqual(w.errors, []); assert.deepEqual(w.external, []);
  } finally { await w?.browser.close(); await t.close(); }
});

test('Chrome: a proven missing receipt permits only explicit original-key retry without persisting its secret', { timeout: 120000 }, async () => {
  const t = await mailboxAccessFixture(true); let w;
  try {
    w = await web(t); const remote = await t.upstream.create(); await fill(w, remote); const bodies = [], keys = [];
    await w.page.route('**/api/v1/mailbox-access-recoveries', async route => {
      bodies.push(route.request().postData()); keys.push(route.request().headers()['idempotency-key']);
      if (bodies.length === 1) await route.abort('failed'); else await route.continue();
    });
    await submit(w); await w.region.getByRole('alert').filter({ hasText: '请使用原请求键核对' }).waitFor();
    assert.equal(await w.region.getByRole('button', { name: '重试原恢复请求', exact: true }).count(), 0); assertReadOnlyProof(t, 0);
    await w.region.getByRole('button', { name: '核对原恢复结果', exact: true }).click();
    await w.region.getByRole('alert').filter({ hasText: '未找到持久回执' }).waitFor();
    await w.region.getByRole('button', { name: '重试原恢复请求', exact: true }).click();
    await w.region.getByRole('status').filter({ hasText: '已导入邮箱访问' }).waitFor();
    assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]); assert.equal(keys[0], keys[1]); assertReadOnlyProof(t, 1);
    assert.equal(await w.region.getByLabel('邮箱访问凭据', { exact: true }).inputValue(), '');
    assert.equal(await w.page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.deepEqual(w.errors, []); assert.deepEqual(w.external, []);
  } finally { await w?.browser.close(); await t.close(); }
});
