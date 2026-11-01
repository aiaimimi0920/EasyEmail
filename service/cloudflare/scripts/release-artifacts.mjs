import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deploymentPlan } from './deployment-config.mjs';

export const workspace = fileURLToPath(new URL('../../../', import.meta.url));
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function releaseInputs() {
  const git = args => execFileSync('git', ['-C', workspace, ...args], { cwd: workspace, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: 16 * 1024 * 1024 });
  const selected = file => /^(?:service\/cloudflare\/(?:src|web|scripts|migrations)\/|service\/base\/src\/|upstreams\/cloudflare_temp_email\/worker\/src\/)/.test(file)
    || ['service/cloudflare/package.json', 'service/cloudflare/package-lock.json', 'service/cloudflare/tsconfig.json',
      'service/base/package.json', 'service/base/package-lock.json', 'service/base/tsconfig.json',
      'upstreams/cloudflare_temp_email/worker/package.json', 'upstreams/cloudflare_temp_email/worker/pnpm-lock.yaml',
      'upstreams/cloudflare_temp_email/worker/tsconfig.json', 'upstreams/cloudflare_temp_email/worker/scripts/build-local.mjs',
      'upstreams/cloudflare_temp_email/worker/patches/telegraf@4.16.3.patch', 'upstreams/cloudflare_temp_email/db/schema.sql'].includes(file);
  const files = [...new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(file => file && selected(file)))].sort();
  const hashes = Object.fromEntries(files.map(file => {
    const source = path.join(workspace, file); assert.ok(fs.lstatSync(source).isFile() && !fs.lstatSync(source).isSymbolicLink(), `Invalid source file: ${file}`);
    return [file, sha256(fs.readFileSync(source))];
  }));
  return { head: git(['rev-parse', 'HEAD']).trim(), branch: git(['branch', '--show-current']).trim(), hashes };
}

export function artifactFiles(directory, prefix = '') {
  const files = [];
  for (const entry of fs.readdirSync(path.join(directory, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const file = prefix ? `${prefix}/${entry.name}` : entry.name; assert.ok(!entry.isSymbolicLink(), 'Artifact symlinks are forbidden');
    if (entry.isDirectory()) files.push(...artifactFiles(directory, file));
    else { assert.ok(entry.isFile(), 'Only regular artifacts are supported'); files.push(file); }
  }
  return files.sort();
}

export function artifactManifest(directory) {
  return artifactFiles(directory).filter(file => file !== 'release.json').map(file => {
    const bytes = fs.readFileSync(path.join(directory, file)); return { path: file, bytes: bytes.length, sha256: sha256(bytes) };
  });
}

export function readDeployment(file) {
  const bytes = fs.readFileSync(file); assert.ok(bytes.length <= 128 * 1024, 'Deployment descriptor is too large');
  assert.ok(!(bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191), 'Deployment descriptor must be UTF-8 without BOM');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw Error('Invalid deployment JSON'); }
}

export async function verifyRelease(directory, expectedSha256) {
  assert.ok(path.isAbsolute(directory), 'An absolute candidate directory is required');
  assert.ok(fs.lstatSync(directory).isDirectory() && !fs.lstatSync(directory).isSymbolicLink(), 'Invalid candidate directory');
  const manifestPath = path.join(directory, 'release.json'); assert.ok(!fs.lstatSync(manifestPath).isSymbolicLink(), 'Invalid manifest');
  const bytes = fs.readFileSync(manifestPath), digest = sha256(bytes);
  if (expectedSha256 !== undefined) assert.equal(digest, expectedSha256, 'Release receipt does not match the external digest');
  const manifest = JSON.parse(bytes.toString('utf8'));
  assert.equal(manifest.version, 1); assert.equal(manifest.status, 'prepared-not-deployed'); assert.equal(manifest.remoteWrites, false); assert.equal(manifest.sourceStable, true);
  assert.equal(manifest.remoteResourcesVerified, false);
  const files = artifactManifest(directory); assert.deepEqual(files, manifest.files, 'Artifact content or file set changed');
  const plan = await deploymentPlan(readDeployment(path.join(directory, 'target.json')));
  for (const component of ['email', 'platform']) {
    const actual = JSON.parse(fs.readFileSync(path.join(directory, component, 'wrangler.json'), 'utf8')); assert.deepEqual(actual, plan[component], 'Worker wiring changed');
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'required-secrets.json'), 'utf8')), { required: plan.requiredSecrets, optional: plan.optionalSecrets });
  return { status: 'verified-not-deployed', directory, manifestSha256: digest, files: files.length, remoteWrites: false,
    remoteResourcesVerified: false, externallyAnchored: expectedSha256 !== undefined };
}
