import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';

const require = createRequire(new URL('../../service/cloudflare/package.json', import.meta.url));
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
test('native D1 signed claims survive lost INSERT response and native R2 cleanup does not need a live Worker', { timeout: 120000 }, async () => {
  const root = await fs.mkdtemp(path.join(process.env.EASYEMAIL_TEST_ROOT, 'resume-native-'));
  const mf = new Miniflare(convertV4MiniflareOptions({ name: 'cleanup-resume-native', modules: true,
    script: 'export default {fetch(){return new Response("fixture")}}', compatibilityDate: '2026-10-23',
    d1Databases: { DB: 'journal' }, r2Buckets: { INBOX: 'inbox', OUTBOX: 'outbox' }, resourcePersistencePath: path.join(root, 'state') }));
  let server; const errors = [], queries = [], deletions = [], downloads = [];
  try {
    await mf.ready; const db = await mf.getD1Database('DB');
    const inbox = await mf.getR2Bucket('INBOX'), outbox = await mf.getR2Bucket('OUTBOX');
    server = http.createServer(async (request, response) => {
      try {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const input = JSON.parse(Buffer.concat(chunks));
        if (request.url === '/seed') {
          for (const [key, content] of Object.entries(input.objects)) await outbox.put(key, Buffer.from(content, 'base64'));
          response.end('{}'); return;
        }
        const url = new URL(input.url); assert.equal(url.origin, 'https://api.cloudflare.com');
        const body = input.body === null ? null : JSON.parse(Buffer.from(input.body, 'base64'));
        let result;
        if (url.pathname.endsWith('/query')) {
          queries.push(body.sql);
          const value = await db.prepare(body.sql).bind(...body.params).all();
          result = Response.json({ success: true, errors: [], result: [{ success: true, results: value.results }] });
        } else {
          const match = url.pathname.match(/\/r2\/buckets\/test-123456abcdef-(inbox|outbox)\/objects(?:\/(.*))?$/);
          assert.ok(match, url.pathname); const bucket = match[1] === 'inbox' ? inbox : outbox;
          if (match[2]) {
            assert.equal(input.method, 'GET'); const key = decodeURIComponent(match[2]); downloads.push(key);
            const object = await bucket.get(key); assert.ok(object);
            result = new Response(await object.arrayBuffer(), { headers: { ETag: 'W/"' + object.etag + '"' } });
          } else if (input.method === 'DELETE') {
            assert.ok(body.length > 0); await bucket.delete(body); deletions.push(...body);
            result = Response.json({ success: true, errors: [], result: body.map(key => ({ key })) });
          } else {
            assert.equal(input.method, 'GET'); const rows = await bucket.list(); assert.equal(rows.truncated, false);
            result = Response.json({ success: true, errors: [], result: rows.objects.map(row => ({ key: row.key, size: row.size,
              etag: row.etag, last_modified: row.uploaded.toISOString() })), result_info: { is_truncated: false } });
          }
        }
        response.end(JSON.stringify({ status: result.status, headers: Object.fromEntries(result.headers),
          body: Buffer.from(await result.arrayBuffer()).toString('base64') }));
      } catch (error) { errors.push(error.stack); response.statusCode = 500; response.end('{}'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const run = await promisify(execFile)('python', [path.resolve('.sba/tests/cleanup-resume-runtime-driver.py'), String(server.address().port)],
      { encoding: 'utf8', timeout: 90000, windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    const value = JSON.parse(run.stdout); assert.deepEqual(errors, []); assert.equal(value.second.status, 'succeeded', run.stdout);
    assert.equal(queries.filter(sql => sql.startsWith('CREATE TABLE')).length, 1);
    assert.equal(queries.filter(sql => sql.startsWith('INSERT INTO')).length, 2);
    const claims = (await db.prepare('SELECT task_id,parent_task_id FROM easyemail_sba_cleanup_claims_v1 ORDER BY rowid').all()).results;
    assert.equal(claims.length, 2); assert.equal(claims[1].parent_task_id, claims[0].task_id);
    assert.equal(downloads.length, 2); assert.equal(new Set(deletions).size, 2);
    assert.deepEqual((await outbox.list()).objects, []); assert.deepEqual((await inbox.list()).objects, []);
    assert.equal(value.metadataWrites.at(-1), 'cleanup-platform-database-deleted');
    await fs.writeFile(path.join(root, 'receipt.json'), JSON.stringify({ nativeD1Claims: true, nativeR2Cleanup: true,
      metadataAndResourceDeletionFixture: true, realCloudDeletion: false, value }, null, 2) + '\n');
    console.log('Native cleanup continuation evidence: ' + root);
  } finally {
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await mf.dispose();
  }
});
