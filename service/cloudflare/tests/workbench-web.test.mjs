import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import { createHarness, PASSWORD } from './runtime-harness.mjs';
import { allocate, cfMail, providerFixture } from './provider-fixture.mjs';

test('Web workbench: real owned cache, split reading, scoped settings, retained draft and narrow navigation', { timeout: 120000 }, async () => {
  const fixture = await providerFixture();
  let h, browser, page;
  try {
    h = await createHarness(fixture.bindings, true);
    const user = await h.register('workbench-alice');
    const box = (await allocate(h, user.cookie)).body.mailbox;
    fixture.messages.set(box.address, [cfMail(box.address, 1, 'Your verification code is 724681.',
      new Date().toISOString().slice(0, 19).replace('T', ' '))]);
    assert.equal((await h.request(`/api/v1/mailboxes/${box.id}/sync`, { cookie: user.cookie, method: 'POST', body: {} })).status, 200);
    const other = await h.register('workbench-bob');
    await allocate(h, other.cookie);
    const calls = fixture.calls.length;
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH
      ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(h.baseUrl.href);
    await page.getByLabel('用户名', { exact: true }).fill(user.username);
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('navigation', { name: '邮件工作台', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '平台管理', exact: true }).count(), 0);
    assert.equal(await page.getByRole('heading', { name: 'API Key', exact: true }).isVisible(), false);
    await page.getByRole('button', { name: '收起导航', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '展开导航', exact: true }).getAttribute('aria-expanded'), 'false');
    assert.equal(await page.getByRole('button', { name: '邮箱管理', exact: true }).isVisible(), true);
    await page.getByRole('button', { name: '展开导航', exact: true }).click();
    await page.getByRole('link', { name: '跳到工作区', exact: true }).focus(); await page.keyboard.press('Enter');
    assert.equal(await page.locator('#workspace-content').evaluate(element => element === document.activeElement), true);
    await page.getByRole('button', { name: box.address, exact: true }).click();
    await page.getByRole('button', { name: 'Verify your account', exact: true }).waitFor();
    let release, enter, finish;
    const held = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { enter = resolve; });
    const fulfilled = new Promise(resolve => { finish = resolve; });
    await page.route(`**/api/v1/mailboxes/${box.id}`, async route => {
      const response = await route.fetch(); enter(); await held;
      try { await route.fulfill({ response }); } finally { finish(); }
    });
    try {
      await page.getByRole('button', { name: box.address, exact: true }).click(); await entered;
      assert.equal(await page.getByLabel('邮箱名称', { exact: true }).isDisabled(), true, 'Mailbox navigation must retain the settings interlock');
    } finally { release(); await fulfilled; await page.unroute(`**/api/v1/mailboxes/${box.id}`); }
    await page.getByRole('button', { name: box.address, exact: true }).waitFor();
    await page.screenshot({ path: path.join(h.directory, 'workbench-empty-reader.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '提取缓存邮件', exact: true }).click();
    assert.equal(await page.getByTestId('otp-code').textContent(), '724681', 'Mailbox-level extraction stays accessible without selecting a message');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: 'Verify your account', exact: true }).click();
    await page.getByTestId('mail-body').waitFor();
    const list = await page.getByTestId('message-list-pane').boundingBox();
    const reading = await page.getByTestId('message-reading-pane').boundingBox();
    assert.ok(list && reading && reading.x >= list.x + list.width - 2, 'Desktop must show side-by-side reading');
    assert.equal(await page.getByRole('button', { name: 'Verify your account', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(h.directory, 'workbench-desktop.png'), fullPage: true });
    await page.getByRole('button', { name: '提取缓存邮件', exact: true }).click();
    assert.equal(await page.getByTestId('otp-code').textContent(), '724681');
    assert.equal(fixture.calls.length, calls, 'Opening cached mail and extracting must not sync providers');
    assert.equal((await h.db.prepare('SELECT is_read FROM messages WHERE mailbox_id=?').bind(box.id).first()).is_read, 0);

    await page.getByRole('button', { name: '用此邮箱写信', exact: true }).click();
    await page.getByLabel('邮件主题', { exact: true }).fill('Retained local workbench draft');
    await page.getByLabel('纯文本正文', { exact: true }).fill('Never send this UI test draft.');
    await page.getByRole('button', { name: '联系人', exact: true }).click();
    await page.getByRole('button', { name: '写信与发送记录', exact: true }).click();
    assert.equal(await page.getByLabel('邮件主题', { exact: true }).inputValue(), 'Retained local workbench draft');
    await page.getByRole('button', { name: 'API Key', exact: true }).click();
    await page.getByRole('heading', { name: 'API Key', exact: true }).waitFor();
    await page.getByRole('button', { name: '邮箱管理', exact: true }).click();
    await page.getByTestId('mail-body').waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByRole('button', { name: '返回邮件列表', exact: true }).click();
    await page.getByRole('button', { name: 'Verify your account', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Verify your account', exact: true }).evaluate(element => element === document.activeElement), true);
    await page.getByRole('button', { name: 'Verify your account', exact: true }).click();
    await page.getByTestId('mail-body').waitFor();
    assert.equal(await page.getByTestId('message-reading-pane').evaluate(element => element === document.activeElement), true);
    await page.screenshot({ path: path.join(h.directory, 'workbench-mobile.png'), fullPage: true });
    assert.deepEqual(errors, []);
    assert.equal(fixture.calls.filter(call => call.path.includes('send_mail')).length, 0);
    console.log(`Web workbench evidence: ${h.directory}`);
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(h.directory, 'workbench-failure.png'), fullPage: true });
    throw error;
  } finally { await browser?.close(); await h?.close(); await fixture.close(); }
});
