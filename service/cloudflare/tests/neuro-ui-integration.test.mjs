import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createHarness, PASSWORD, seedMailbox } from './runtime-harness.mjs';

const root = new URL('../', import.meta.url);
const read = file => fs.readFileSync(new URL(file, root), 'utf8');

test('Web consumes the standard Neuro package, installed copies and shared provider instead of desktop skins', () => {
  const manifest = JSON.parse(read('package.json'));
  assert.equal(manifest.dependencies['@neuro/ui'], 'file:../../../NeuroDesign/packages/react/neuro-ui');
  assert.match(manifest.scripts['ui:sync'], /NeuroDesign\/scripts\/sync-consumer\.mjs --package @neuro\/ui$/);
  assert.equal(read('.npmrc').trim(), 'install-links=true');
  assert.match(read('web/app.tsx'), /@neuro\/ui\/styles\.css/);
  assert.match(read('web/app.tsx'), /<NeuroProvider[\s>]/);
  assert.doesNotMatch(read('web/app.css'), /apps\/desktop|mail-theme-tokens/);
});

test('Web standard controls are package components; native file upload is the deliberate exception', () => {
  const violations = [];
  for (const file of fs.readdirSync(new URL('web/', root)).filter(file => file.endsWith('.tsx'))) {
    assert.doesNotMatch(read(`web/${file}`), /\bwindow\.(confirm|alert|prompt)\s*\(/, `${file}: standard overlays must not regress to native dialogs`);
    const source = ts.createSourceFile(file, read(`web/${file}`), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node) {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(source);
        const fileInput = tag === 'input' && node.attributes.properties.some(attr => ts.isJsxAttribute(attr)
          && attr.name.text === 'type' && attr.initializer && ts.isStringLiteral(attr.initializer) && attr.initializer.text === 'file');
        if (['button', 'input', 'select', 'textarea', 'details', 'summary'].includes(tag) && !fileInput) {
          violations.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} ${tag}`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.deepEqual(violations, []);
});

test('App styles own layout, not a parallel standard-control skin', () => {
  const styles = ['controls', 'workbench', 'mail-workspace'].map(name => read(`web/styles/${name}.css`)).join('\n');
  assert.doesNotMatch(styles, /--nt-|button\.primary|button\.secondary|input\[type="checkbox"\]/);
  assert.doesNotMatch(read('web/WorkbenchShell.tsx'), /EASYEMAIL \/ WORKSPACE/);
});

test('Chrome: actual standard theme, native form submission, field associations and controlled checkbox survive integration', { timeout: 60000 }, async () => {
  const h = await createHarness({}, true);
  let browser;
  try {
    const user = await h.register('neuro-ui-user');
    const mailboxId = await seedMailbox(h, user.id, 'neuro-ui@example.test');
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH
      ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(h.baseUrl.href);
    const login = page.getByRole('button', { name: '登录', exact: true });
    assert.match(await login.getAttribute('class'), /n-button--primary/);
    assert.equal(await login.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(217, 255, 56)');
    await page.getByLabel('用户名', { exact: true }).fill(user.username);
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByLabel('密码', { exact: true }).press('Enter');
    const navigation = page.getByRole('navigation', { name: '邮件工作台', exact: true });
    await navigation.waitFor();
    assert.equal(await navigation.getByRole('button', { name: '邮箱管理', exact: true }).getAttribute('aria-current'), 'page');
    assert.match(await navigation.getByRole('button', { name: '邮箱管理', exact: true }).getAttribute('class'), /n-navigation-item/);
    const skip = page.getByRole('link', { name: '跳到工作区', exact: true });
    await skip.focus();
    assert.match(await skip.getAttribute('class'), /n-button-link/);
    assert.equal(await skip.evaluate(element => getComputedStyle(element).color), await primaryInk(page));
    await skip.press('Enter');
    assert.equal(await page.locator('#workspace-content').evaluate(element => element === document.activeElement), true);
    await page.getByRole('button', { name: 'neuro-ui@example.test', exact: true }).click();
    const settings = page.getByRole('region', { name: '邮箱设置', exact: true });
    const name = settings.getByLabel('邮箱名称', { exact: true });
    await name.fill('标准控件邮箱');
    assert.match(await name.getAttribute('class'), /n-input/);
    await settings.getByLabel('邮箱备注', { exact: true }).fill('local standard control acceptance');
    await settings.getByRole('checkbox', { name: '收藏邮箱', exact: true }).check();
    assert.equal(await page.locator('label label').count(), 0, 'Checkbox must not nest its own label in a legacy label');
    const saved = page.waitForResponse(response => response.url().endsWith(`/api/v1/mailboxes/${mailboxId}`) && response.request().method() === 'PATCH');
    await settings.getByRole('button', { name: '保存邮箱设置', exact: true }).click();
    assert.equal((await saved).status(), 200);
    const row = await h.db.prepare('SELECT display_name, note, favorite FROM mailboxes WHERE id=?').bind(mailboxId).first();
    assert.deepEqual(row, { display_name: '标准控件邮箱', note: 'local standard control acceptance', favorite: 1 });
    await page.getByRole('heading', { name: '邮箱管理工作区', exact: true }).click();
    await page.screenshot({ path: path.join(h.directory, 'neuro-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(h.directory, 'neuro-mobile.png') });
    assert.deepEqual(errors, []);
    console.log(`Neuro UI browser evidence: ${h.directory}`);
  } finally { await browser?.close(); await h.close(); }
});

async function primaryInk(page) {
  return page.locator('.neuro-root').evaluate(element => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--n-on-primary)'; element.append(probe);
    const color = getComputedStyle(probe).color; probe.remove(); return color;
  });
}
