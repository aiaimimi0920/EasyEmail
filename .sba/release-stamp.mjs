// Public release evidence wraps only fetch; email and scheduled lifecycle handlers are preserved.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { builtinModules, createRequire } from 'node:module';
import { artifactManifest, sha256 } from '../service/cloudflare/scripts/release-artifacts.mjs';
import { previewBuildOptions, previewPolicy } from './preview-release.mjs';

export const releasePath = '/.well-known/easyemail-release.json';
const write = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
const { build } = createRequire(new URL('../service/cloudflare/package.json', import.meta.url))('esbuild');

export function releaseEntry(marker, main, control = null, preview = false) {
  return `import application from ${JSON.stringify(main)};
${control ? `import { objectControl } from ${JSON.stringify(control)};` : ''}
const marker = ${JSON.stringify(marker)};
export default { ...application, ${preview ? `email(message) { message.setReject('EASYEMAIL_PREVIEW_EMAIL_DISABLED'); }, scheduled() {},` : ''} async fetch(request, env, context) {
  ${control ? 'const controlled = await objectControl(request, env); if (controlled) return controlled;' : ''}
  if (new URL(request.url).pathname === ${JSON.stringify(releasePath)}) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
    return new Response(request.method === 'HEAD' ? null : JSON.stringify(marker), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
    });
  }
  return application.fetch(request, env, context);
} };
`;
}

export async function stampRelease(candidate, destination, metadata, descriptor) {
  assert.ok(path.isAbsolute(candidate) && path.isAbsolute(destination));
  assert.ok(!Object.keys(metadata).some(key => !['applicationId', 'applicationVersion', 'sourceSha', 'configurationDigest'].includes(key)));
  assert.equal(metadata.applicationId, 'easyemail');
  assert.match(metadata.applicationVersion, /^\d+\.\d+\.\d+$/);
  assert.match(metadata.sourceSha, /^[a-f0-9]{40}$/); assert.match(metadata.configurationDigest, /^[a-f0-9]{64}$/);
  const original = JSON.parse(await fs.readFile(path.join(candidate, 'release.json'), 'utf8'));
  assert.equal(original.source.head, metadata.sourceSha, 'Candidate source SHA does not match the SBA request');
  await fs.mkdir(destination);
  for (const entry of await fs.readdir(candidate)) {
    if (entry !== 'release.json') await fs.cp(path.join(candidate, entry), path.join(destination, entry),
      { recursive: true, errorOnExist: true, force: false });
  }
  const markers = {};
  for (const component of ['email', 'platform']) {
    const directory = path.join(destination, component), configPath = path.join(directory, 'wrangler.json');
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    const assets = component === 'email' ? [] : (await artifactManifest(path.join(directory, 'web'))).map(row => ({
      path: row.path === 'index.html' ? '/' : '/' + row.path, bytes: row.bytes, sha256: row.sha256
    }));
    const marker = { schemaVersion: 1, ...metadata, component, assets }; markers[component] = marker;
    const main = path.resolve(directory, config.main), entry = path.join(path.dirname(main), 'sba-entry.mjs');
    // Keep the publish entry self-contained, like the original Worker; do not rely on runtime import discovery.
    const control = component === 'platform' ? './' + path.relative(path.dirname(main), fileURLToPath(new URL('./object-control.mjs', import.meta.url))).replaceAll('\\', '/') : null;
    await build({ stdin: { contents: releaseEntry(marker, './' + path.basename(main), control, Boolean(descriptor.preview)), resolveDir: path.dirname(main) },
      outfile: entry, bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
      external: [...builtinModules, 'node:*', 'cloudflare:*'], sourcemap: true, logLevel: 'silent',
      ...(descriptor.preview ? previewBuildOptions(component, descriptor.preview) : {}) });
    config.main = './' + path.relative(directory, entry).replaceAll('\\', '/');
    if (component === 'platform') {
      config.vars.PROVIDER_CONFIG = JSON.stringify([...JSON.parse(config.vars.PROVIDER_CONFIG), ...descriptor.providers]);
      // The registration invitation is always required by this deployment adapter.
    }
    await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  }
  const secretsPath = path.join(destination, 'required-secrets.json');
  const secrets = JSON.parse(await fs.readFile(secretsPath, 'utf8'));
  secrets.required.platform = [...new Set([...secrets.required.platform, 'EASYEMAIL_SBA_CONTROL_SECRET'])];
  await fs.writeFile(secretsPath, JSON.stringify(secrets, null, 2) + '\n', 'utf8');
  const files = artifactManifest(destination);
  const proof = { schemaVersion: 1, status: 'prepared-not-deployed', metadata, markers, files,
    ...(descriptor.preview ? { previewPolicy: previewPolicy(descriptor.preview) } : {}),
    originalManifestSha256: sha256(await fs.readFile(path.join(candidate, 'release.json'))) };
  await write(path.join(path.dirname(destination), 'sba-release.json'), proof);
  return proof;
}

export async function verifyStampedRelease(destination, proofPath, expectedDigest, expectedMetadata) {
  assert.match(expectedDigest, /^[a-f0-9]{64}$/, 'An external proof digest is required');
  const bytes = await fs.readFile(proofPath);
  assert.equal(sha256(bytes), expectedDigest, 'SBA release proof changed');
  const proof = JSON.parse(bytes);
  assert.equal(proof.schemaVersion, 1); assert.equal(proof.status, 'prepared-not-deployed');
  assert.deepEqual(proof.metadata, expectedMetadata, 'SBA release request changed');
  assert.deepEqual(artifactManifest(destination), proof.files, 'SBA publish artifacts changed');
  return proof;
}

if (pathToFileURL(path.resolve(process.argv[1] ?? '')).href === import.meta.url) {
  if (process.argv[2] === 'verify') {
    assert.equal(process.argv.length, 7, 'Usage: node release-stamp.mjs verify <publish> <proof> <expected-sha256> <expected-metadata.json>');
    await verifyStampedRelease(process.argv[3], process.argv[4], process.argv[5], JSON.parse(await fs.readFile(process.argv[6], 'utf8')));
  } else {
    assert.equal(process.argv.length, 6, 'Usage: node release-stamp.mjs <candidate> <destination> <metadata.json> <descriptor.json>');
    const metadata = JSON.parse(await fs.readFile(process.argv[4], 'utf8'));
    const descriptor = JSON.parse(await fs.readFile(process.argv[5], 'utf8'));
    await stampRelease(process.argv[2], process.argv[3], metadata, descriptor);
    const proof = path.join(path.dirname(process.argv[3]), 'sba-release.json');
    await verifyStampedRelease(process.argv[3], proof, sha256(await fs.readFile(proof)), metadata);
  }
}
