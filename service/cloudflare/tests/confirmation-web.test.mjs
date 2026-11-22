import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import { foldersFixture } from './folders-fixture.mjs';
import { PASSWORD } from './runtime-harness.mjs';

const button = (page, name) => page.getByRole('button', { name, exact: true });

test('Chrome: standard confirmation cancels safely, traps focus, restores focus and confirms only once', { timeout: 120000 }, async () => {
  const f = await foldersFixture({}, true), { h, alice } = f;
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    page.setDefaultTimeout(10000);
    const errors = [], native = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { native.push(dialog.message()); void dialog.dismiss(); });
    await page.goto(h.baseUrl.href);
    await page.getByLabel('用户名', { exact: true }).fill(alice.username);
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await button(page, '登录').click();
    await button(page, '聚合收件箱').click();
    await page.getByText('管理文件夹', { exact: true }).click();
    await page.getByLabel('文件夹名称', { exact: true }).fill('确认验收');
    await button(page, '创建文件夹').click();
    const trigger = button(page, '删除文件夹 确认验收'), dialog = page.getByRole('alertdialog');
    await trigger.click(); await dialog.waitFor();
    assert.match(await dialog.textContent(), /直属子文件夹移到根目录/);
    assert.match(await dialog.getAttribute('class'), /n-dialog/);
    assert.equal(await button(dialog, '取消').evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await dialog.evaluate(el => el.contains(document.activeElement)), true);
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM folders WHERE name='确认验收'").first('n'), 1);
    await trigger.click(); await button(dialog, '取消').click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await trigger.count(), 1);
    await page.setViewportSize({ width: 390, height: 844 });
    await trigger.click(); await dialog.waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(h.directory, 'neuro-confirm-mobile.png') });
    const writes = [];
    page.on('request', request => { if (request.method() === 'DELETE' && request.url().includes('/folders/')) writes.push(request.url()); });
    await button(dialog, '确认').dblclick();
    await trigger.waitFor({ state: 'detached' });
    assert.equal(writes.length, 1);
    assert.deepEqual(native, []); assert.deepEqual(errors, []);
    console.log(`Confirmation browser evidence: ${h.directory}`);
  } finally { await browser?.close(); await f.close(); }
});
