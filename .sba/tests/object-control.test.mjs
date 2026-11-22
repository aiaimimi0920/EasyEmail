import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { before, after, test } from 'node:test';

const require = createRequire(new URL('../../service/cloudflare/package.json', import.meta.url));
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const { build } = require('esbuild');
const secret = 'a1'.repeat(32), prefix = '/__easyemail_sba/v1/';
let mf, targetMf, inbox, outbox, directory;
before(async () => {
  directory = await fs.mkdtemp(path.join(process.env.EASYEMAIL_TEST_ROOT, 'sba-objects-'));
  const source = path.resolve('.sba/object-control.mjs').replaceAll('\\', '/');
  const entry = path.join(directory, 'worker.mjs');
  const contentReader = path.resolve('service/cloudflare/src/outbox-content.ts').replaceAll('\\', '/');
  await build({ stdin: { contents: `import { objectControl } from ${JSON.stringify(source)};
    import { readAssetObject } from ${JSON.stringify(contentReader)};
    // Miniflare's R2 backend returns an empty class even for an explicit Standard PUT.
    // Only this missing emulator field is supplied; bytes, versions, metadata and conditionals stay native.
    const classified = object => object && new Proxy(object,{get(target,key){
      return key==='storageClass' && target.storageClass==='' ? 'Standard' : Reflect.get(target,key,target);
    }});
    const bucket = value => new Proxy(value,{get(target,key){
      if (['get','head','put'].includes(key)) return async (...args) => classified(await target[key](...args));
      if (key==='list') return async options => {const result=await target.list(options);return {...result,objects:result.objects.map(classified)};};
      return Reflect.get(target,key,target);
    }});
    export default { async fetch(request,env) {
      env={...env,INBOX:bucket(env.INBOX),OUTBOX:bucket(env.OUTBOX)};
      if (new URL(request.url).pathname === '/test-asset') {
        try { return new Response((await readAssetObject(env,await request.json())).bytes); }
        catch(error) {return new Response(error.code,{status:error.status??500});}
      }
      if (new URL(request.url).pathname === '/test-asset-db') {
        try { return new Response((await readAssetObject(env,await env.DB.prepare("SELECT * FROM outbox_assets WHERE id='asset'").first())).bytes); }
        catch(error) {return new Response(error.code,{status:error.status??500});}
      }
      return await objectControl(request,env) ?? new Response('application');
    } };`,
    resolveDir: path.resolve('.') }, outfile: entry, bundle: true, format: 'esm', platform: 'neutral',
    external: ['node:*'], logLevel: 'silent' });
  mf = new Miniflare(convertV4MiniflareOptions({ name: 'sba-object-test', modules: true, scriptPath: entry, modulesRoot: directory,
    compatibilityDate: '2026-10-23', compatibilityFlags: ['nodejs_compat'],
    resourcePersistencePath: path.join(directory, 'source-state'),
    r2Buckets: { INBOX: 'source-inbox', OUTBOX: 'source-outbox' }, bindings: { EASYEMAIL_SBA_CONTROL_SECRET: secret } }));
  await mf.ready; inbox = await mf.getR2Bucket('INBOX'); outbox = await mf.getR2Bucket('OUTBOX');
  const probe = await inbox.put('storage-class-probe', new Uint8Array(), { storageClass: 'Standard' });
  assert.ok(['', 'Standard'].includes(probe.storageClass));
  console.log('Miniflare models explicit Standard storageClass: ' + (probe.storageClass === 'Standard'));
  targetMf = new Miniflare(convertV4MiniflareOptions({ name: 'sba-object-target', modules: true, scriptPath: entry, modulesRoot: directory,
    compatibilityDate: '2026-10-23', compatibilityFlags: ['nodejs_compat'], r2Buckets: { INBOX: 'target-inbox', OUTBOX: 'target-outbox' },
    resourcePersistencePath: path.join(directory, 'target-state'),
    d1Databases: { DB: 'restore-database' },
    bindings: { EASYEMAIL_SBA_CONTROL_SECRET: 'b2'.repeat(32) } }));
  await targetMf.ready;
});
after(async () => { await Promise.all([mf?.dispose(), targetMf?.dispose()]); });

function request(route, { method = 'GET', auth = secret, body, metadata, headers = {} } = {}) {
  const values = new Headers(headers);
  if (auth !== null) values.set('authorization', 'Bearer ' + auth);
  if (metadata) values.set('x-easyemail-r2-metadata', Buffer.from(JSON.stringify(metadata)).toString('base64'));
  if (body !== undefined) { values.set('content-type', 'application/octet-stream'); values.set('content-length', String(body.length)); }
  return mf.dispatchFetch('https://preview.example.com' + prefix + route, { method, headers: values, body });
}
const sha256 = value => createHash('sha256').update(value).digest('hex');

test('control paths are opaque without the independent secret and do not expose object metadata', async () => {
  await inbox.put('private', 'private content');
  for (const auth of [null, 'wrong', 'b2'.repeat(32)]) {
    const response = await request('objects?bucket=INBOX', { auth });
    assert.equal(response.status, 404); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(await response.text(), /private/);
  }
  assert.equal((await mf.dispatchFetch('https://preview.example.com/ordinary')).status, 200);
});

test('native R2 list/get preserve object bytes, versions and Unicode metadata across pagination', async () => {
  const bytes = Buffer.from('snapshot bytes \u0000 \u00ff'), key = 'folder/邮件 ?#%&.bin';
  await inbox.put(key, bytes, { customMetadata: { owner: '本地验收', sha256: sha256(bytes) },
    httpMetadata: { contentType: 'application/test', cacheControl: 'private' } });
  const response = await request('object?' + new URLSearchParams({ bucket: 'INBOX', key }));
  assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  const metadata = JSON.parse(Buffer.from(response.headers.get('x-easyemail-r2-metadata'), 'base64').toString('utf8'));
  const original = await inbox.head(key);
  assert.equal(metadata.version, original.version); assert.equal(metadata.etag, original.etag);
  assert.deepEqual(metadata.customMetadata, original.customMetadata); assert.deepEqual(metadata.httpMetadata, original.httpMetadata);
  for (let index = 0; index < 51; index++) await outbox.put('pagination/' + String(index).padStart(3, '0'), 'x');
  const first = await (await request('objects?bucket=OUTBOX')).json();
  assert.ok(first.objects.every(row => ['Standard', 'InfrequentAccess'].includes(row.storageClass)), JSON.stringify([...new Set(first.objects.map(row => row.storageClass))]));
  assert.equal(first.objects.length, 50); assert.equal(first.truncated, true); assert.equal(typeof first.cursor, 'string');
  const next = await (await request('objects?' + new URLSearchParams({ bucket: 'OUTBOX', cursor: first.cursor }))).json();
  assert.equal(next.objects.length, 1); assert.equal(next.truncated, false);
  assert.equal(new Set([...first.objects, ...next.objects].map(row => row.key)).size, 51);
});

test('restore PUT preserves metadata, requires digest and never overwrites or retries an existing object', async () => {
  const body = Buffer.from('restored attachment'), key = 'restore/attachment';
  const metadata = { size: body.length, sha256: sha256(body), customMetadata: { owner: 'owner-id', asset: 'asset-id', label: '附件' },
    httpMetadata: { contentType: 'application/test', cacheExpiry: '2030-01-01T00:00:00.000Z' }, storageClass: 'Standard' };
  const url = 'object?' + new URLSearchParams({ bucket: 'OUTBOX', key });
  const restored = await request(url, { method: 'PUT', body, metadata });
  assert.equal(restored.status, 201, await restored.clone().text()); const receipt = await restored.json();
  const actual = await outbox.get(key);
  assert.deepEqual(Buffer.from(await actual.arrayBuffer()), body); assert.deepEqual(actual.customMetadata, metadata.customMetadata);
  assert.equal(actual.httpMetadata.contentType, metadata.httpMetadata.contentType);
  assert.equal(actual.httpMetadata.cacheExpiry.toISOString(), metadata.httpMetadata.cacheExpiry);
  assert.equal(receipt.version, actual.version); assert.equal(receipt.etag, actual.etag);
  const repeated = await request(url, { method: 'PUT', body, metadata });
  assert.equal(repeated.status, 409); assert.equal((await outbox.head(key)).version, receipt.version);
  const bad = await request('object?bucket=OUTBOX&key=restore%2Fbad', { method: 'PUT', body, metadata: { ...metadata, sha256: '0'.repeat(64) } });
  assert.equal(bad.status, 503); assert.equal(await outbox.head('restore/bad'), null);
});

test('unexpected fields, duplicate query values, absent buckets and overlarge writes fail before object creation', async () => {
  for (const url of ['objects?bucket=DB', 'objects?bucket=INBOX&bucket=OUTBOX', 'objects?bucket=INBOX&extra=1', 'object?bucket=INBOX', 'unknown']) {
    assert.equal((await request(url)).status, 400, url);
  }
  const body = Buffer.from('x'), base = { size: 1, sha256: sha256(body), httpMetadata: {}, customMetadata: {} };
  for (const metadata of [{ ...base, size: 268435457 }, { ...base, size: true }, { ...base, version: 'unsupported' },
    { ...base, customMetadata: { bad: 7 } }, { ...base, httpMetadata: { injected: 'header' } }]) {
    assert.equal((await request('object?bucket=OUTBOX&key=invalid', { method: 'PUT', body, metadata })).status, 400);
  }
  assert.equal(await outbox.head('invalid'), null);
});

test('Python persists encrypted SQL fixtures and both native R2 buckets, then restores a readable attachment through native D1', { timeout: 120000 }, async () => {
  const routes = [], errors = [], allowed = new Map([['https://source.example.com', mf], ['https://target.example.com', targetMf]]);
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')), url = new URL(input.url);
      assert.ok(allowed.has(url.origin)); routes.push({ origin: url.origin, method: input.method, key: url.searchParams.get('key') });
      assert.ok(url.pathname.startsWith(prefix));
      const result = await allowed.get(url.origin).dispatchFetch(url.href, { method: input.method, headers: input.headers,
        body: input.body === null ? undefined : Buffer.from(input.body, 'base64') });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: result.status, headers: Object.fromEntries(result.headers), body: Buffer.from(await result.arrayBuffer()).toString('base64') }));
    } catch (error) { errors.push(error.message); response.statusCode = 500; response.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = path.join(directory, 'python-copy');
  try {
    const result = await promisify(execFile)('python', [path.resolve('.sba/tests/object-snapshot-driver.py'), String(server.address().port), root],
      { windowsHide: true, encoding: 'utf8', timeout: 110000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    assert.equal(JSON.parse(result.stdout).status, 'passed'); assert.deepEqual(errors, []);
    assert.equal(JSON.parse(result.stdout).persistedRestoreProof, true);
    assert.ok(routes.some(row => row.origin === 'https://target.example.com' && row.method === 'PUT'));
    assert.ok(routes.every(row => row.origin !== 'https://source.example.com' || row.method === 'GET'
      || row.method === 'PUT' && row.key.startsWith('_easyemail-sba/backups/')));
    const receipts = JSON.parse(await fs.readFile(path.join(root, 'copy-receipts.json'), 'utf8'));
    const asset = receipts.find(row => row.bucket === 'OUTBOX' && row.source.key === 'restore/attachment');
    assert.notEqual(asset.source.version, asset.target.version); assert.deepEqual(asset.source.customMetadata, asset.target.customMetadata);
    const row = { object_key: asset.source.key, size: asset.source.size, sha256: asset.sha256,
      object_version: asset.source.version, object_etag: asset.source.etag };
    const read = value => targetMf.dispatchFetch('https://target.example.com/test-asset', { method: 'POST', body: JSON.stringify(value) });
    assert.equal((await read(row)).status, 409);
    const rebound = await read({ ...row, object_version: asset.target.version, object_etag: asset.target.etag });
    assert.equal(rebound.status, 200); assert.equal(await rebound.text(), 'restored attachment');
    const sql = await fs.readFile(path.join(root, 'platform-rebound.sql'), 'utf8');
    const database = await targetMf.getD1Database('DB');
    // Import the prepared dump without SQLite transaction wrappers, as required by D1 queries.
    await database.exec(sql.replace(/^BEGIN TRANSACTION;\r?\n|^COMMIT;\r?\n/gm, ''));
    const native = await targetMf.dispatchFetch('https://target.example.com/test-asset-db');
    assert.equal(native.status, 200); assert.equal(await native.text(), 'restored attachment');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
