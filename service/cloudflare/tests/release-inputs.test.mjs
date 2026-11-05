import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseInputs } from '../scripts/release-artifacts.mjs';
import { neuroUiInputs } from '../scripts/neuro-ui-inputs.mjs';
import fs from 'node:fs';
import path from 'node:path';

test('release source receipts cover actual build entrypoints, implicit compiler configuration and dependency installation patches', () => {
  const inputs = releaseInputs();
  for (const file of ['service/cloudflare/scripts/build.mjs', 'service/cloudflare/tsconfig.json', 'service/cloudflare/web/tsconfig.json',
    'service/base/tsconfig.json', 'service/base/package.json', 'service/base/package-lock.json',
    'upstreams/cloudflare_temp_email/worker/scripts/build-local.mjs', 'upstreams/cloudflare_temp_email/worker/tsconfig.json',
    'upstreams/cloudflare_temp_email/worker/patches/telegraf@4.16.3.patch', 'service/cloudflare/package-lock.json',
    'upstreams/cloudflare_temp_email/worker/pnpm-lock.yaml', 'service/cloudflare/.npmrc',
    'dependencies/@neuro/ui/package.json', 'dependencies/@neuro/ui/dist/index.js', 'dependencies/@neuro/ui/dist/styles.css',
    'apps/desktop/src/components/AppIcons.tsx']) assert.match(inputs.hashes[file] ?? '', /^[a-f0-9]{64}$/, file);
  assert.equal(Object.keys(inputs.hashes).some(file => /(?:\.dev\.vars|config\.yaml|node_modules)/.test(file)), false);
  assert.equal(inputs.hashes['apps/desktop/src/styles/mail-theme-tokens.css'], undefined);
});

test('local UI artifact receipts detect same-version dist changes without reading unrelated packages', () => {
  const directory = fs.mkdtempSync(path.join(process.env.EASYEMAIL_TEST_ROOT, 'ui-inputs-'));
  fs.mkdirSync(path.join(directory, 'dist'));
  fs.writeFileSync(path.join(directory, 'package.json'), '{"name":"@neuro/ui","version":"0.1.1"}\n');
  for (const file of ['index.js', 'styles.css', 'index.d.ts']) fs.writeFileSync(path.join(directory, 'dist', file), 'original\n');
  const before = neuroUiInputs(directory);
  fs.writeFileSync(path.join(directory, 'dist/styles.css'), 'changed\n');
  const after = neuroUiInputs(directory);
  assert.equal(after['dependencies/@neuro/ui/package.json'], before['dependencies/@neuro/ui/package.json']);
  assert.notEqual(after['dependencies/@neuro/ui/dist/styles.css'], before['dependencies/@neuro/ui/dist/styles.css']);
});
