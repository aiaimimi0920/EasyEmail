import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { createHarness } from './runtime-harness.mjs';
import { confirmAction } from './confirmation-driver.mjs';

const button = (page, name) => page.getByRole('button', { name, exact: true });

test('Chrome: FIFO, duplicate rejection, owner changes/unmount and superseded compose requests are safe', { timeout: 90000 }, async () => {
  const h = await createHarness({}, true);
  let browser;
  try {
    const bundle = await build({ entryPoints: ['tests/confirmation-fixture.tsx'], bundle: true, write: false,
      format: 'esm', jsx: 'automatic', minify: true, logLevel: 'silent' });
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const page = await browser.newPage(); page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/assets/app.js', route => route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text }));
    await page.route('**/api/v1/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      return route.fulfill({ json: pathname.endsWith('/providers') ? { items: [] } : { items: [], nextCursor: null } });
    });
    await page.goto(h.baseUrl.href);
    const dialog = page.getByRole('alertdialog');
    await button(page, '请求 A').click();
    await page.evaluate(() => [...document.querySelectorAll('button')].find(el => el.textContent === '请求 B').click());
    assert.match(await dialog.textContent(), /请求 A/);
    await button(dialog, '确认').dblclick();
    await dialog.filter({ hasText: '请求 B' }).waitFor();
    assert.equal(await button(dialog, '取消').evaluate(el => el === document.activeElement), true);
    await button(dialog, '取消').click(); await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(await page.evaluate(() => confirmationFixture.results), ['请求 A:true', '请求 B:false']);
    await page.evaluate(() => confirmationFixture.same());
    await confirmAction(page, async () => {
      await button(page, '请求 A').click();
      await page.evaluate(() => [...document.querySelectorAll('button')].find(el => el.textContent === '请求 B').click());
    }, [prompt => { assert.match(prompt.message(), /相同风险/); return prompt.accept(); },
      prompt => { assert.match(prompt.message(), /相同风险/); return prompt.dismiss(); }]);
    assert.deepEqual(await page.evaluate(() => confirmationFixture.results.slice(-2)), ['请求 A:true', '请求 B:false']);
    await page.evaluate(() => {
      const trigger = [...document.querySelectorAll('button')].find(el => el.textContent === '请求 A');
      trigger.click(); trigger.click();
    });
    await dialog.waitFor(); await page.waitForFunction(() => confirmationFixture.results.length === 5);
    assert.equal(await page.evaluate(() => confirmationFixture.results.at(-1)), '请求 A:false');
    await button(dialog, '确认').click(); await dialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => confirmationFixture.results.length === 6);
    await button(page, '请求 A').click();
    await page.evaluate(() => confirmationFixture.change()); await dialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => confirmationFixture.results.length === 7);
    assert.equal(await page.evaluate(() => confirmationFixture.results.at(-1)), '请求 A:false');
    await button(page, '请求 A').click();
    await page.evaluate(() => confirmationFixture.unmount()); await dialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => confirmationFixture.results.length === 8);
    assert.equal(await page.evaluate(() => confirmationFixture.results.at(-1)), '请求 A:false');
    await button(page, '请求 B').click();
    await page.evaluate(() => confirmationFixture.mode('empty')); await dialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => confirmationFixture.results.length === 9);
    assert.equal(await page.evaluate(() => confirmationFixture.results.at(-1)), '请求 B:false');
    await page.evaluate(() => confirmationFixture.mode('composer'));
    await page.getByLabel('邮件主题', { exact: true }).fill('保留的草稿');
    await page.evaluate(() => confirmationFixture.request('First')); await dialog.waitFor();
    await page.evaluate(() => confirmationFixture.request('Second'));
    await dialog.waitFor(); await button(dialog, '取消').click(); await dialog.waitFor({ state: 'hidden' });
    assert.equal(await page.getByLabel('邮件主题', { exact: true }).inputValue(), '保留的草稿');
    await page.evaluate(() => confirmationFixture.request('Third')); await dialog.waitFor();
    await button(dialog, '确认').click();
    await page.waitForFunction(() => document.querySelector('[id$="-subject"]')?.value === 'Re: Third');
    assert.equal(await page.getByLabel('收件地址', { exact: true }).inputValue(), 'third@example.test');
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await h.close(); }
});
