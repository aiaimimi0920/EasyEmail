// Explicit local substitutes for Cloudflare metadata/export/CLI; real packaged Workers and D1/R2 own data.
import assert from 'node:assert/strict';
import http from 'node:http';

const quoted = value => '"' + value.replaceAll('"', '""') + '"';
export async function dump(database) {
  const schema = (await database.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND sql IS NOT NULL ORDER BY type,name").all()).results;
  const tables = schema.filter(row => row.type === 'table'), lines = tables.map(row => row.sql + ';');
  for (const table of tables) {
    const columns = (await database.prepare('PRAGMA table_info(' + quoted(table.name) + ')').all()).results.map(row => row.name);
    const expressions = columns.map(name => `CASE WHEN typeof(${quoted(name)})='text' THEN 'CAST(X'''||hex(CAST(${quoted(name)} AS BLOB))||''' AS TEXT)' ELSE quote(${quoted(name)}) END`);
    const rows = await database.prepare('SELECT ' + expressions.join(',') + ' FROM ' + quoted(table.name)).raw();
    for (const row of rows) lines.push(`INSERT INTO ${quoted(table.name)} VALUES(${row.join(',')});`);
  }
  if ((await database.prepare("SELECT name FROM sqlite_master WHERE name='sqlite_sequence'").all()).results.length) {
    lines.push('DELETE FROM sqlite_sequence;');
    for (const row of (await database.prepare('SELECT quote(name) name,quote(seq) seq FROM sqlite_sequence').all()).results) {
      lines.push(`INSERT INTO sqlite_sequence VALUES(${row.name},${row.seq});`);
    }
  }
  lines.push(...schema.filter(row => row.type !== 'table').map(row => row.sql + ';'));
  return Buffer.from(lines.join('\n'), 'utf8');
}

async function nativeR2Field(response, url) {
  // Miniflare's only supplied field: explicit Standard PUT still reads back storageClass="".
  if (!url.pathname.startsWith('/__easyemail_sba/v1/') || response.status >= 400) return response;
  const headers = new Headers(response.headers), bytes = Buffer.from(await response.arrayBuffer());
  const classified = row => { assert.ok(['', 'Standard'].includes(row.storageClass)); return { ...row, storageClass: 'Standard' }; };
  if (url.pathname.endsWith('/objects')) {
    const value = JSON.parse(bytes.toString('utf8')); value.objects = value.objects.map(classified);
    headers.delete('content-length');
    return new Response(JSON.stringify(value), { status: response.status, headers });
  }
  if (headers.has('x-easyemail-r2-metadata')) {
    const row = classified(JSON.parse(Buffer.from(headers.get('x-easyemail-r2-metadata'), 'base64').toString('utf8')));
    headers.set('x-easyemail-r2-metadata', Buffer.from(JSON.stringify(row)).toString('base64'));
    return new Response(bytes, { status: response.status, headers });
  }
  headers.delete('content-length');
  return new Response(JSON.stringify(classified(JSON.parse(bytes.toString('utf8')))), { status: response.status, headers });
}

export async function upgradeRuntimeBridge(fixture, config) {
  const downloads = new Map(), routes = [], errors = []; let exports = 0, upgrades = 0;
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')), url = new URL(input.url);
      routes.push({ origin: url.origin, method: input.method, path: url.pathname });
      let result;
      if (url.origin === 'https://api.cloudflare.com') {
        const match = url.pathname.match(/^\/client\/v4\/accounts\/([^/]+)\/d1\/database\/([^/]+)\/(query|export)$/);
        assert.ok(match); assert.equal(match[1], config.accountId); assert.equal(input.method, 'POST');
        const role = ['email', 'platform'].find(role => config[role].database.id === match[2]); assert.ok(role);
        const database = role === 'email' ? fixture.emailDb : fixture.db;
        if (match[3] === 'query') {
          const value = JSON.parse(Buffer.from(input.body, 'base64').toString('utf8'));
          const query = await database.prepare(value.sql).bind(...value.params).all();
          result = new Response(JSON.stringify({ success: true, errors: [], result: [{ success: true, results: query.results }] }));
        } else {
          const path = '/fixture-' + (++exports) + '.sql'; downloads.set(path, await dump(database));
          result = new Response(JSON.stringify({ success: true, errors: [], result: { success: true, type: 'export', status: 'complete',
            at_bookmark: 'local-synthetic-bookmark', result: { signed_url: 'https://export.synthetic.r2.cloudflarestorage.com' + path } } }));
        }
      } else if (url.origin === 'https://export.synthetic.r2.cloudflarestorage.com') {
        assert.equal(input.method, 'GET'); assert.equal(new Headers(input.headers).has('authorization'), false);
        assert.ok(downloads.has(url.pathname)); result = new Response(downloads.get(url.pathname));
      } else if (url.origin === 'https://local-upgrade.test') {
        assert.equal(input.method, 'POST'); assert.equal(url.pathname, '/apply'); assert.equal(upgrades++, 0);
        assert.deepEqual(await fixture.reapplyMigrations(), []);
        await fixture.restart(); result = new Response('{}');
      } else {
        assert.ok([config.email.origin, config.platform.origin].includes(url.origin));
        const options = { method: input.method, headers: input.headers, body: input.body === null ? undefined : Buffer.from(input.body, 'base64') };
        result = url.origin === config.email.origin ? await fixture.emailRequest(url.pathname + url.search, options)
          : await nativeR2Field(await fixture.dispatch(url.href, options), url);
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: result.status, headers: Object.fromEntries(result.headers), body: Buffer.from(await result.arrayBuffer()).toString('base64') }));
    } catch (error) { errors.push(error.message); response.statusCode = 500; response.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, routes, errors, get exports() { return exports; }, get upgrades() { return upgrades; },
    close: () => new Promise(resolve => server.close(resolve)) };
}
