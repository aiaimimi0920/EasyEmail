// Use the application's vault, provider parser and Hono JWT implementation; never export plaintext credentials.
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../service/cloudflare/', import.meta.url));
const { build } = createRequire(new URL('../service/cloudflare/package.json', import.meta.url))('esbuild');
let loaded;
export function previewRuntime() {
  return loaded ??= (async () => {
    const result = await build({ stdin: { contents: `export { encryptCredential,decryptCredential } from './src/mailbox-vault';
      export { parseProviderConfig } from './src/providers/config'; export { sign,verify } from 'hono/jwt';`, resolveDir: root },
      bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2022', logLevel: 'silent' });
    const code = result.outputFiles[0].text + '\n//# sourceURL=easyemail-preview-runtime.mjs';
    return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
  })();
}

export async function rewritePreview(input) {
  const runtime = await previewRuntime(), configuration = input.configuration;
  assert.ok(Array.isArray(input.mailboxes) && input.mailboxes.length <= 100000);
  assert.ok(Array.isArray(input.providers) && input.providers.length <= 20);
  assert.equal(new Set(input.mailboxes.map(row => row.id)).size, input.mailboxes.length);
  assert.equal(new Set(input.providers.map(row => row.id)).size, input.providers.length);
  const mailboxes = [];
  for (const row of input.mailboxes) {
    assert.equal(row.provider_id, 'self');
    const credential = await runtime.decryptCredential(input.sourceEnv, row, row.credential_cipher);
    // Preserve expiry semantics, including already-expired mailboxes, while independently checking the signature.
    const claims = await runtime.verify(credential.token, input.sourceJwt, { alg: 'HS256', exp: false, iat: false, nbf: false });
    assert.equal(claims.address, row.address); assert.equal(String(claims.address_id), row.remote_id);
    const payload = { address: claims.address, address_id: claims.address_id };
    for (const key of ['exp', 'iat', 'nbf']) if (claims[key] !== undefined) payload[key] = claims[key];
    const token = await runtime.sign(payload, input.targetJwt, 'HS256');
    mailboxes.push({ id: row.id, cipher: await runtime.encryptCredential(input.targetEnv, row, { ...credential, token }) });
  }
  const providers = input.providers.map(row => {
    const source = runtime.parseProviderConfig({ APP_ORIGIN: configuration.sourcePlatform }, JSON.parse(row.config_json));
    assert.equal(source.id, row.id);
    const own = row.id === 'self';
    if (own) { assert.equal(source.type, 'cloudflare'); assert.equal(source.baseUrl, configuration.sourceEmail); }
    const config = runtime.parseProviderConfig({ APP_ORIGIN: configuration.targetPlatform }, { ...source,
      baseUrl: configuration.targetEmail + (own ? '' : '/_easyemail_preview_disabled/' + row.id),
      enabled: own ? source.enabled : false, sendTransport: undefined, sendRecipients: [], domains: own ? [configuration.mailDomain] : source.domains });
    return { id: row.id, config_json: JSON.stringify(config) };
  });
  return { mailboxes, providers };
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) { size += chunk.length; assert.ok(size <= 67108864); chunks.push(chunk); }
    process.stdout.write(JSON.stringify(await rewritePreview(JSON.parse(Buffer.concat(chunks).toString('utf8')))));
  } catch { process.stderr.write('EASYEMAIL_PREVIEW_CREDENTIAL_FAILED\n'); process.exitCode = 1; }
}
