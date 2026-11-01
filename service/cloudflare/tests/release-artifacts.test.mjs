import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { prepareRelease } from '../scripts/prepare-release.mjs';
import { artifactFiles, verifyRelease, workspace } from '../scripts/release-artifacts.mjs';
import { deploymentFixture, acceptanceDeploymentFixture } from './deployment-config-fixture.mjs';

let directory, result;
before(async () => {
  assert.ok(process.env.EASYEMAIL_TEST_ROOT && path.isAbsolute(process.env.EASYEMAIL_TEST_ROOT));
  directory = await fs.mkdtemp(path.join(process.env.EASYEMAIL_TEST_ROOT, 'release-artifacts-'));
  result = await prepareRelease(deploymentFixture(), path.join(directory, 'prepared'));
}, { timeout: 180000 });
after(() => { console.log(`Release artifact evidence: ${directory}`); });

test('preparation produces relocatable, externally hash-verifiable artifacts for both complete Workers without local secrets', async () => {
  const verification = await verifyRelease(result.directory, result.manifestSha256); assert.equal(verification.status, 'verified-not-deployed');
  assert.equal(verification.remoteWrites, false); assert.equal(verification.remoteResourcesVerified, false);
  const files = artifactFiles(result.directory);
  for (const required of ['platform/server/worker.mjs', 'platform/web/index.html', 'platform/web/assets/app.js', 'platform/web/assets/app.css',
    'email/bundle/worker.js', 'email/schema.sql', 'platform/migrations/0053_normal_remote_flags.sql',
    'platform/migrations/0054_normal_server_folders.sql', 'platform/migrations/0055_normal_server_folder_inbox.sql', 'platform/migrations/0056_normal_folder_organization.sql',
    'platform/migrations/0057_normal_folder_remote_flags.sql', 'platform/migrations/0058_normal_remote_mutations.sql',
    'platform/migrations/0059_mailbox_access_recoveries.sql', 'required-secrets.json']) assert.ok(files.includes(required), required);
  assert.equal(files.filter(file => file.startsWith('platform/migrations/') && file.endsWith('.sql')).length, 59);
  assert.equal(files.some(file => /(?:\.dev\.vars|config\.yaml|node_modules|\.ts$)/.test(file)), false);
  const configs = await Promise.all(['email', 'platform'].map(component => fs.readFile(path.join(result.directory, component, 'wrangler.json'), 'utf8')));
  for (const config of configs) { assert.equal(config.includes('synthetic-local-build-secret'), false); assert.equal(config.includes('C:\\'), false); assert.equal(config.includes('JWT_SECRET'), false); }
  const relocated = path.join(directory, 'relocated'); await fs.cp(result.directory, relocated, { recursive: true });
  assert.equal((await verifyRelease(relocated, result.manifestSha256)).files, verification.files);
});

test('isolated acceptance survives real dual-bundle dry-run and manifest verification without routes, cron or public entry', async () => {
  const target = acceptanceDeploymentFixture(), prepared = await prepareRelease(target, path.join(directory, 'isolated-prepared'));
  assert.equal((await verifyRelease(prepared.directory, prepared.manifestSha256)).status, 'verified-not-deployed');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(prepared.directory, 'target.json'), 'utf8')), target);
  for (const component of ['email', 'platform']) {
    const config = JSON.parse(await fs.readFile(path.join(prepared.directory, component, 'wrangler.json'), 'utf8'));
    assert.equal(config.workers_dev, false); assert.equal(config.preview_urls, false);
    assert.deepEqual(config.routes, []); assert.deepEqual(config.triggers.crons, []); assert.equal(config.send_email, undefined);
  }
  const secrets = JSON.parse(await fs.readFile(path.join(prepared.directory, 'required-secrets.json'), 'utf8'));
  assert.deepEqual(secrets.required.platform, ['MAILBOX_KEYRING', 'PROVIDER_SECRETS', 'REGISTRATION_TOKEN']);
});

test('output reuse and invalid descriptors fail before overwriting anything, and there is no deploy/execute mode', async () => {
  const sentinel = path.join(directory, 'sentinel'); await fs.mkdir(sentinel); await fs.writeFile(path.join(sentinel, 'keep.txt'), 'retain', 'utf8');
  await assert.rejects(prepareRelease(deploymentFixture(), sentinel), /already exists/); assert.equal(await fs.readFile(path.join(sentinel, 'keep.txt'), 'utf8'), 'retain');
  const invalid = deploymentFixture(); invalid.email.JWT_SECRET = 'secret-must-not-be-read'; const target = path.join(directory, 'invalid');
  await assert.rejects(prepareRelease(invalid, target), error => !error.message.includes('secret-must-not-be-read'));
  await assert.rejects(fs.stat(target), { code: 'ENOENT' }); await assert.rejects(prepareRelease(deploymentFixture(), 'relative-output'), /absolute/);
  const insideSource = path.join(workspace, `release-output-rejected-${crypto.randomUUID()}`);
  await assert.rejects(prepareRelease(deploymentFixture(), insideSource), /outside the source workspace/); await assert.rejects(fs.stat(insideSource), { code: 'ENOENT' });
  const source = await fs.readFile(new URL('../scripts/prepare-release.mjs', import.meta.url), 'utf8');
  assert.equal(source.includes("'--dry-run'"), true); assert.equal(source.includes("args[0] === 'deploy'"), false); assert.equal(source.includes("'--execute'"), false);
});

test('verification rejects modified bytes, unexpected files, removed migrations and an altered external manifest digest', async () => {
  await assert.rejects(verifyRelease(result.directory, '0'.repeat(64)), /external digest/);
  const mutations = [async dir => fs.appendFile(path.join(dir, 'platform/server/worker.mjs'), '\n// corrupt\n', 'utf8'),
    async dir => fs.writeFile(path.join(dir, 'unexpected.txt'), 'not in release', 'utf8'),
    async dir => fs.unlink(path.join(dir, 'platform/migrations/0001_identity.sql'))];
  for (const [index, mutate] of mutations.entries()) {
    const target = path.join(directory, `corrupt-${index}`); await fs.cp(result.directory, target, { recursive: true }); await mutate(target);
    await assert.rejects(verifyRelease(target, result.manifestSha256), /Artifact content or file set changed/);
  }
  assert.equal((await verifyRelease(result.directory, result.manifestSha256)).status, 'verified-not-deployed');
});

test('CLI plans and verifies a real relocated candidate, rejects unsupported modes, and never echoes malformed descriptor contents', async () => {
  const cli = fileURLToPath(new URL('../scripts/prepare-release.mjs', import.meta.url));
  const run = args => spawnSync(process.execPath, [cli, ...args], { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const plan = run(['plan', path.join(result.directory, 'target.json')]); assert.equal(plan.status, 0, plan.stderr);
  assert.equal(JSON.parse(plan.stdout).status, 'planned-not-deployed');
  const verified = run(['verify', path.join(directory, 'relocated'), result.manifestSha256]); assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).externallyAnchored, true);
  const reused = run(['prepare', path.join(result.directory, 'target.json'), path.join(directory, 'sentinel')]);
  assert.equal(reused.status, 1); assert.match(reused.stderr, /already exists/);
  for (const args of [['deploy'], ['execute'], ['provision'], ['plan'], ['plan', 'missing.json', '--execute'],
    ['verify', result.directory, result.manifestSha256, '--deploy']]) {
    const denied = run(args); assert.equal(denied.status, 1); assert.match(denied.stderr, /Usage:/);
  }
  const malformed = path.join(directory, 'malformed.json'); await fs.writeFile(malformed, '{"private":"secret-must-not-be-echoed",', 'utf8');
  const invalid = run(['plan', malformed]); assert.equal(invalid.status, 1); assert.match(invalid.stderr, /Invalid deployment JSON/);
  assert.equal((invalid.stdout + invalid.stderr).includes('secret-must-not-be-echoed'), false);
});

test('manifest verification rejects a junction that would add artifacts from outside the candidate', async () => {
  const target = path.join(directory, 'junction-candidate'); await fs.cp(result.directory, target, { recursive: true });
  await fs.symlink(path.join(result.directory, 'email'), path.join(target, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verifyRelease(target, result.manifestSha256), /symlinks are forbidden/);
});
