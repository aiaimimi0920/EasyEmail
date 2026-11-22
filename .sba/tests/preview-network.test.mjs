import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { builtinModules, createRequire } from 'node:module';
import { test } from 'node:test';
import { previewBuildOptions, previewPolicy } from '../preview-release.mjs';
import { releaseEntry } from '../release-stamp.mjs';

const require = createRequire(new URL('../../service/cloudflare/package.json', import.meta.url));
const { build } = require('esbuild');
const { convertV4MiniflareOptions, Miniflare } = require('miniflare');
const emailOrigin = 'https://test-123456abcdef-email.synthetic.workers.dev';
const scratch = process.env.EASYEMAIL_TEST_ROOT;
const main = `import { connect } from 'cloudflare:sockets';
export default { async fetch(request) {
  const url = new URL(request.url), mode = url.searchParams.get('mode');
  try {
    if (mode === 'socket') { connect({hostname:'source.example.com',port:25}); return new Response('unexpected'); }
    if (mode === 'websocket') { new WebSocket('wss://source.example.com'); return new Response('unexpected'); }
    if (mode === 'global') return await globalThis.fetch(url.searchParams.get('to'));
    return await fetch(url.searchParams.get('to'));
  } catch { return new Response('blocked', {status:403}); }
}, async email(message, env) { env.events.push('email'); await message.forward('source@example.com'); },
async scheduled(event, env) { env.events.push('scheduled'); } };`;

async function fixture(role, source = main) {
  assert.ok(path.isAbsolute(scratch));
  const root = await fs.mkdtemp(path.join(scratch, 'pnet-'));
  await fs.writeFile(path.join(root, 'application.mjs'), source, 'utf8');
  const entry = releaseEntry({ component: role }, './application.mjs', null, true);
  const outfile = path.join(root, 'worker.mjs');
  await build({ stdin: { contents: entry, resolveDir: root }, outfile, bundle: true, format: 'esm', platform: 'neutral',
    target: 'es2022', logLevel: 'silent', ...previewBuildOptions(role, emailOrigin) });
  const outbound = [];
  const worker = new Miniflare(convertV4MiniflareOptions({ name: 'sba-preview-network-test', modules: true, scriptPath: outfile, modulesRoot: root,
    compatibilityDate: '2026-10-23', compatibilityFlags: ['nodejs_compat'],
    resourcePersistencePath: path.join(root, 's'),
    outboundService(request) {
      outbound.push(request.url);
      return request.url.endsWith('/redirect') ? new Response(null, { status:302, headers:{location:'https://source.example.com/leak'} })
        : new Response('local-copy');
    } }));
  try { await worker.ready; }
  catch (error) { await worker.dispose(); throw error; }
  return { root, worker, outbound, async request(mode, to = emailOrigin + '/health_check') {
    return worker.dispatchFetch('https://preview.example.test/attempt?' + new URLSearchParams({mode,to}));
  } };
}

test('preview permits only the cloned self HTTP origin and blocks source/external fetch before transport', async () => {
  const value = await fixture('platform');
  try {
    for (const mode of ['fetch','global']) {
      assert.equal(await (await value.request(mode)).text(), 'local-copy');
      for (const to of ['https://source.example.com/mail', 'https://test-123456abcdef-email.synthetic.workers.dev.evil.test/',
        emailOrigin.replace('https:', 'http:'), emailOrigin + ':8443/', emailOrigin.replace('https://','https://user:secret@')]) {
        assert.equal((await value.request(mode,to)).status,403);
      }
    }
    assert.deepEqual(value.outbound,[emailOrigin+'/health_check',emailOrigin+'/health_check']);
  } finally { await value.worker.dispose(); }
});

test('preview never follows even same-origin redirects and blocks raw sockets and WebSocket', async () => {
  const value = await fixture('platform');
  try {
    assert.equal((await value.request('fetch',emailOrigin+'/redirect')).status,403);
    assert.equal((await value.request('socket')).status,403);
    assert.equal((await value.request('websocket')).status,403);
    assert.deepEqual(value.outbound,[emailOrigin+'/redirect']);
    assert.doesNotMatch(await fs.readFile(path.join(value.root,'worker.mjs'),'utf8'), /from ["']cloudflare:sockets["']/);
  } finally { await value.worker.dispose(); }
});

test('cloned email Worker cannot use even the clone HTTP origin for outbound requests', async () => {
  const value = await fixture('email');
  try {
    for (const mode of ['fetch','global','socket','websocket']) assert.equal((await value.request(mode)).status,403);
    assert.deepEqual(value.outbound,[]);
  } finally { await value.worker.dispose(); }
});

test('preview rejects inbound email and ignores scheduled work instead of invoking copied handlers', async () => {
  const root = await fs.mkdtemp(path.join(scratch,'pevents-'));
  await fs.writeFile(path.join(root,'application.mjs'),main.replace("import { connect } from 'cloudflare:sockets';",''),'utf8');
  await fs.writeFile(path.join(root,'entry.mjs'),releaseEntry({component:'email'},'./application.mjs',null,true),'utf8');
  const { pathToFileURL } = await import('node:url');
  const app = (await import(pathToFileURL(path.join(root,'entry.mjs')).href)).default;
  const events = [], rejected = [];
  await app.email({ setReject: message=>rejected.push(message), forward: async()=>events.push('forward') },{events});
  await app.scheduled({cron:'* * * * *'},{events});
  assert.deepEqual(events,[]); assert.deepEqual(rejected,['EASYEMAIL_PREVIEW_EMAIL_DISABLED']);
});

test('preview policy accepts only a validated isolated clone origin and rejects native Node network imports', async () => {
  assert.deepEqual(previewPolicy(emailOrigin),{emailOrigin,fetchRedirects:'manual-reject',sockets:false,websockets:false,inboundEmail:false,scheduled:false});
  for (const origin of ['https://email-api.example.com',emailOrigin+'/path',emailOrigin.replace('test-123456abcdef','production')]) {
    assert.throws(()=>previewPolicy(origin));
  }
  for (const name of ['node:http','node:https','node:net','node:tls','node:http2','node:dgram','node:dns','node:undici']) {
    await assert.rejects(build({stdin:{contents:`import * as net from '${name}'; console.log(net);`,resolveDir:path.resolve('.')},
      bundle:true,write:false,format:'esm',platform:'neutral',logLevel:'silent',external:[...builtinModules,'node:*','cloudflare:*'],
      ...previewBuildOptions('platform',emailOrigin)}),/EASYEMAIL_PREVIEW_NATIVE_NETWORK_FORBIDDEN/);
  }
});
