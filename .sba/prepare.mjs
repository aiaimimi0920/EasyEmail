// Reuse production validators and existing release construction; this command never publishes.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { prepareRelease } from '../service/cloudflare/scripts/prepare-release.mjs';
import { deploymentPlan } from '../service/cloudflare/scripts/deployment-config.mjs';
import { sha256 } from '../service/cloudflare/scripts/release-artifacts.mjs';
import { stampRelease, verifyStampedRelease } from './release-stamp.mjs';

const root = fileURLToPath(new URL('../service/cloudflare/', import.meta.url));
const { build } = createRequire(new URL('../service/cloudflare/package.json', import.meta.url))('esbuild');

export async function validateRuntime(descriptor, providers) {
  const plan = await deploymentPlan(descriptor);
  assert.ok(Array.isArray(providers));
  if (plan.mode === 'isolated-acceptance') assert.equal(providers.length, 0);
  const result = await build({ stdin: { contents: `export { environmentConfigs, endpointOrigins, CONFIG_FIELDS } from './src/providers/config';`, resolveDir: root },
    bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent' });
  const validators = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].contents).toString('base64'));
  for (const row of providers) assert.ok(Object.keys(row).every(key => validators.CONFIG_FIELDS.includes(key)), 'Unexpected provider field');
  const vars = { ...plan.platform.vars, PROVIDER_CONFIG: JSON.stringify([...JSON.parse(plan.platform.vars.PROVIDER_CONFIG), ...providers]) };
  const configs = validators.environmentConfigs(vars), origins = validators.endpointOrigins(vars, configs);
  assert.equal(configs.length, providers.length + 1);
  assert.ok(configs.every(row => origins.has(new URL(row.baseUrl).origin)));
  return plan;
}

export async function prepare(input, output) {
  const { metadata, descriptor, providers } = input;
  const plan = await validateRuntime(descriptor, providers);
  if (input.preview !== undefined) assert.equal(typeof input.preview, 'boolean');
  if (input.preview) assert.equal(plan.mode, 'isolated-acceptance');
  await fs.mkdir(output);
  await prepareRelease(descriptor, path.join(output, 'base'));
  await stampRelease(path.join(output, 'base/candidate'), path.join(output, 'publish'), metadata,
    { providers, preview: input.preview ? descriptor.email.origin : null });
  const proof = path.join(output, 'sba-release.json');
  return verifyStampedRelease(path.join(output, 'publish'), proof, sha256(await fs.readFile(proof)), metadata);
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 4, 'Usage: node .sba/prepare.mjs <input.json> <absolute-new-output>');
  await prepare(JSON.parse(await fs.readFile(process.argv[2], 'utf8')), process.argv[3]);
}
