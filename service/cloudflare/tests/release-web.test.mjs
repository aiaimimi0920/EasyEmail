import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import { mime } from './upstream-fixture.mjs';
import { releaseRuntimeFixture, RELEASE_PASSWORD } from './release-runtime-fixture.mjs';
import { acceptanceDeploymentFixture } from './deployment-config-fixture.mjs';

for (const isolated of [false, true]) test(`Chrome ${isolated ? 'planned workers.dev' : 'custom domain'}: relocated release uses HTTPS Secure cookies to create, receive, read and extract without external access`, { timeout: 180000 }, async () => {
  const f = await releaseRuntimeFixture(isolated ? acceptanceDeploymentFixture(true) : undefined); let browser, page;
  const external = [], errors = [], requests = [];
  try {
    const user = await f.register('release-web-user');
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    // Preserve the exact planned HTTPS Origin and __Host Secure-cookie semantics. Only transport is local.
    await context.route('**/*', async route => {
      const request = route.request();
      if (new URL(request.url()).origin !== f.target.platform.origin) { external.push(request.url()); return route.abort('blockedbyclient'); }
      requests.push({ method: request.method(), path: new URL(request.url()).pathname });
      try {
        const response = await f.dispatch(request.url(), { method: request.method(), headers: await request.allHeaders(), body: request.postDataBuffer() ?? undefined });
        const headers = Object.fromEntries(response.headers); delete headers['content-length']; delete headers['content-encoding'];
        await route.fulfill({ status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) });
      } catch (error) { errors.push(`Local transport: ${error.message}`); await route.abort('failed'); }
    });
    page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    await page.goto(f.target.platform.origin); await page.getByLabel('用户名', { exact: true }).fill(user.username);
    await page.getByLabel('密码', { exact: true }).fill(RELEASE_PASSWORD); await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('button', { name: '退出登录', exact: true }).waitFor();
    const cookie = (await context.cookies()).find(row => row.name === '__Host-ee_session');
    assert.ok(cookie); assert.equal(cookie.secure, true); assert.equal(cookie.httpOnly, true); assert.equal(cookie.sameSite, 'Strict');
    await page.getByRole('combobox', { name: '域名', exact: true }).selectOption(f.target.email.domains[0]);
    await page.getByRole('button', { name: '分配随机邮箱', exact: true }).click();
    await page.getByRole('heading', { name: '收件箱', exact: true }).waitFor();
    const box = await f.db.prepare('SELECT id,address FROM mailboxes WHERE user_id=?').bind(user.id).first(); assert.ok(box);
    assert.equal((await f.deliver(box.address, mime(box.address, '724681'))).rejectReason, undefined);
    await page.getByRole('button', { name: '刷新收信', exact: true }).click();
    await page.getByRole('button', { name: 'Verify complete worker', exact: true }).click(); await page.getByTestId('mail-body').waitFor();
    assert.match(await page.getByTestId('mail-body').textContent(), /724681/);
    await page.getByRole('button', { name: '提取缓存邮件', exact: true }).click(); assert.equal(await page.getByTestId('otp-code').textContent(), '724681');
    await page.screenshot({ path: path.join(f.directory, 'release-mail-mobile.png'), fullPage: true });
    await page.reload(); await page.getByRole('button', { name: box.address, exact: true }).click();
    await page.getByRole('button', { name: 'Verify complete worker', exact: true }).waitFor();
    await f.restart(); await page.reload(); await page.getByRole('button', { name: box.address, exact: true }).click();
    await page.getByRole('button', { name: 'Verify complete worker', exact: true }).click();
    await page.getByTestId('mail-body').waitFor(); assert.match(await page.getByTestId('mail-body').textContent(), /724681/);
    const text = await page.locator('body').innerText(); assert.equal(text.includes('synthetic-release-'), false);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(external, []); assert.deepEqual(errors, []); await f.checkIntegrity();
    await page.screenshot({ path: path.join(f.directory, 'release-restarted-mobile.png'), fullPage: true });
    await fs.writeFile(path.join(f.directory, 'browser-audit.json'), JSON.stringify({ status: 'passed', origin: f.target.platform.origin,
      viewport: { width: 390, height: 844 }, secureCookie: { secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite },
      requests, external, errors, localStorageAndSessionStorageEmpty: true, remoteMailDelivery: false }, null, 2) + '\n', 'utf8');
    console.log(`Packaged Chrome evidence: ${f.directory}`);
  } catch (error) {
    if (page) { console.error(await page.locator('body').ariaSnapshot()); await page.screenshot({ path: path.join(f.directory, 'release-web-failure.png'), fullPage: true }); }
    throw error;
  } finally { try { await browser?.close(); } finally { await f.close(); } }
});
