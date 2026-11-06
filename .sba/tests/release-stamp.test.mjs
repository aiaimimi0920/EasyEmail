import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { releaseEntry, releasePath, stampRelease, verifyStampedRelease } from '../release-stamp.mjs';
import { validateRuntime } from '../prepare.mjs';
import { sha256 } from '../../service/cloudflare/scripts/release-artifacts.mjs';

const scratch = process.env.EASYEMAIL_TEST_ROOT ?? (process.platform === 'win32' ? 'C:/Users/Public/nas_home/AI/GameEditor/linshi' : os.tmpdir());
const metadata = { applicationId: 'easyemail', applicationVersion: '1.0.0', sourceSha: 'b'.repeat(40), configurationDigest: 'c'.repeat(64) };
const write = (file, value) => fs.writeFile(file, JSON.stringify(value), 'utf8');

test('release entry preserves actual fetch/email/scheduled handlers and exposes only approved metadata', async () => {
  const root = await fs.mkdtemp(path.join(scratch, 'easyemail-sba-entry-'));
  await fs.writeFile(path.join(root, 'application.mjs'), `export default {
    fetch: request => new Response(new URL(request.url).pathname),
    email: (message, env) => env.received.push(message), scheduled: (event, env) => env.crons.push(event.cron)
  };`, 'utf8');
  const marker = { schemaVersion: 1, ...metadata, component: 'email', assets: [] };
  await fs.writeFile(path.join(root, 'entry.mjs'), releaseEntry(marker, './application.mjs'), 'utf8');
  const { default: app } = await import(pathToFileURL(path.join(root, 'entry.mjs')).href);
  const response = await app.fetch(new Request('https://public.example.com' + releasePath));
  assert.deepEqual(await response.json(), marker); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await app.fetch(new Request('https://public.example.com' + releasePath, { method: 'POST' }))).status, 405);
  assert.equal(await (await app.fetch(new Request('https://public.example.com' + releasePath, { method: 'HEAD' }))).text(), '');
  assert.equal(await (await app.fetch(new Request('https://public.example.com/actual-api'))).text(), '/actual-api');
  const env = { received: [], crons: [] }; await app.email('message', env); await app.scheduled({ cron: 'test' }, env);
  assert.deepEqual(env, { received: ['message'], crons: ['test'] });
});

test('sealed base is unchanged, stamped assets are hashed and publish drift is rejected', async () => {
  const root = await fs.mkdtemp(path.join(scratch, 'easyemail-sba-stamp-')), candidate = path.join(root, 'candidate');
  await fs.mkdir(path.join(candidate, 'platform/web/assets'), { recursive: true });
  await fs.mkdir(path.join(candidate, 'platform/server'), { recursive: true });
  await fs.mkdir(path.join(candidate, 'email/bundle'), { recursive: true });
  await fs.writeFile(path.join(candidate, 'platform/web/index.html'), '<html>test</html>');
  await fs.writeFile(path.join(candidate, 'platform/web/assets/app.js'), 'test');
  for (const component of ['email', 'platform']) {
    const main = component === 'email' ? './bundle/worker.js' : './server/worker.mjs';
    await fs.writeFile(path.join(candidate, component, main), 'export default {fetch(){}};');
    await write(path.join(candidate, component, 'wrangler.json'), { main, vars: { PROVIDER_CONFIG: '[]' } });
  }
  await write(path.join(candidate, 'release.json'), { source: { head: metadata.sourceSha } });
  await write(path.join(candidate, 'required-secrets.json'), { required: { platform: [], email: [] }, optional: {} });
  const base = await fs.readFile(path.join(candidate, 'platform/wrangler.json'), 'utf8');
  const publish = path.join(root, 'publish'), proof = await stampRelease(candidate, publish, metadata, { providers: [] });
  assert.equal(await fs.readFile(path.join(candidate, 'platform/wrangler.json'), 'utf8'), base);
  assert.equal(proof.markers.platform.assets.length, 2);
  const config = JSON.parse(await fs.readFile(path.join(publish, 'platform/wrangler.json'), 'utf8'));
  assert.equal(config.main, './server/sba-entry.mjs');
  assert.ok(JSON.parse(await fs.readFile(path.join(publish, 'required-secrets.json'), 'utf8')).required.platform.includes('EASYEMAIL_SBA_CONTROL_SECRET'));
  const proofPath = path.join(root, 'sba-release.json'), digest = sha256(await fs.readFile(proofPath));
  await verifyStampedRelease(publish, proofPath, digest, metadata);
  await fs.appendFile(path.join(publish, 'platform/web/assets/app.js'), 'drift');
  await assert.rejects(verifyStampedRelease(publish, proofPath, digest, metadata), /artifacts changed/);
  await write(proofPath, { ...proof, metadata: { ...metadata, sourceSha: 'd'.repeat(40) } });
  await assert.rejects(verifyStampedRelease(publish, proofPath, digest, metadata), /release proof changed/);
});

function descriptor() {
  const database = (name, id) => ({ name, id });
  return { version: 1, accountId: 'a'.repeat(32), acceptance: { workersDev: true },
    email: { name: 'test-123456abcdef-email', origin: 'https://test-123456abcdef-email.synthetic.workers.dev', domains: ['isolated.test'],
      database: database('test-123456abcdef-email-db', '11111111-1111-1111-1111-111111111111'), sendRecipients: [] },
    platform: { name: 'test-123456abcdef-platform', origin: 'https://test-123456abcdef-platform.synthetic.workers.dev',
      database: database('test-123456abcdef-platform-db', '22222222-2222-2222-2222-222222222222'),
      inboxBucket: 'test-123456abcdef-inbox', outboxBucket: 'test-123456abcdef-outbox', imapEndpoints: [], smtpEndpoints: [], providerEndpointOrigins: [] } };
}

test('SpringBok test prefix keeps the same no-cron/no-send/no-external-provider acceptance policy', async () => {
  const value = descriptor(), plan = await validateRuntime(value, []);
  assert.deepEqual(plan.email.routes, []); assert.deepEqual(plan.platform.triggers.crons, []);
  assert.equal(plan.email.send_email, undefined);
  await assert.rejects(validateRuntime(value, [{ id: 'external', type: 'temporam', baseUrl: 'https://external.example.com' }]));
  value.platform.outboxBucket = 'test-fedcba654321-outbox';
  await assert.rejects(validateRuntime(value, []), /acceptance resource prefix/);
});

test('production provider configuration uses the runtime parser, not an unvalidated extra JSON list', async () => {
  const value = descriptor(); delete value.acceptance;
  value.email.origin = 'https://email-api.example.com'; value.platform.origin = 'https://mail.example.com'; value.email.domains = ['example.com'];
  const extra = { id: 'external', type: 'temporam', baseUrl: 'https://api.example.com', domains: [] };
  await validateRuntime(value, [extra]);
  await assert.rejects(validateRuntime(value, [{ ...extra, apiKey: 'must-never-be-public' }]), /Unexpected provider field/);
  await assert.rejects(validateRuntime(value, [{ ...extra, id: 'self' }]));
  await assert.rejects(validateRuntime(value, [{ ...extra, type: 'not-implemented' }]));
});
