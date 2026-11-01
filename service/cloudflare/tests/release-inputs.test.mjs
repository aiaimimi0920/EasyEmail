import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseInputs } from '../scripts/release-artifacts.mjs';

test('release source receipts cover actual build entrypoints, implicit compiler configuration and dependency installation patches', () => {
  const inputs = releaseInputs();
  for (const file of ['service/cloudflare/scripts/build.mjs', 'service/cloudflare/tsconfig.json', 'service/cloudflare/web/tsconfig.json',
    'service/base/tsconfig.json', 'service/base/package.json', 'service/base/package-lock.json',
    'upstreams/cloudflare_temp_email/worker/scripts/build-local.mjs', 'upstreams/cloudflare_temp_email/worker/tsconfig.json',
    'upstreams/cloudflare_temp_email/worker/patches/telegraf@4.16.3.patch', 'service/cloudflare/package-lock.json',
    'upstreams/cloudflare_temp_email/worker/pnpm-lock.yaml']) assert.match(inputs.hashes[file] ?? '', /^[a-f0-9]{64}$/, file);
  assert.equal(Object.keys(inputs.hashes).some(file => /(?:\.dev\.vars|config\.yaml|node_modules)/.test(file)), false);
});
