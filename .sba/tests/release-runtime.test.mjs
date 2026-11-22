import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { promisify } from 'node:util';
import { before, after, test } from 'node:test';
import { prepare } from '../prepare.mjs';
import { releasePath, verifyStampedRelease } from '../release-stamp.mjs';
import { releaseInputs, sha256 } from '../../service/cloudflare/scripts/release-artifacts.mjs';
import { acceptanceDeploymentFixture } from '../../service/cloudflare/tests/deployment-config-fixture.mjs';
import { releaseRuntimeFixture } from '../../service/cloudflare/tests/release-runtime-fixture.mjs';
import { mime } from '../../service/cloudflare/tests/upstream-fixture.mjs';
import { upgradeRuntimeBridge } from './upgrade-runtime-bridge.mjs';

let fixture, proofPath, proof, configuration, configurationPath;
const driver = path.resolve('.sba/tests/initial-runtime-driver.py');
before(async () => {
  const target = acceptanceDeploymentFixture(); target.acceptance.workersDev = true;
  configuration = { accountId: target.accountId, email: { ...target.email }, platform: { ...target.platform },
    mailDomain: target.email.domains[0], routing: null, settings: { adminUsername: 'admin', providers: [],
      sendRecipients: [], providerOrigins: [], imapEndpoints: [], smtpEndpoints: [] } };
  delete configuration.email.domains; delete configuration.email.sendRecipients;
  delete configuration.platform.imapEndpoints; delete configuration.platform.smtpEndpoints; delete configuration.platform.providerEndpointOrigins;
  const canonical = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(canonical)
    : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const metadata = { applicationId: 'easyemail', applicationVersion: '1.0.0', sourceSha: releaseInputs().head,
    configurationDigest: sha256(Buffer.from(JSON.stringify(canonical(configuration)))) };
  const inputDirectory = await fs.mkdtemp(path.join(process.env.EASYEMAIL_TEST_ROOT, 'sba-initial-runtime-'));
  configurationPath = path.join(inputDirectory, 'configuration.json');
  await fs.writeFile(configurationPath, JSON.stringify(configuration), 'utf8');
  const secrets = spawnSync('python', [driver, 'material', configurationPath], { encoding: 'utf8', timeout: 30000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, windowsHide: true });
  assert.equal(secrets.status, 0, secrets.stderr);
  fixture = await releaseRuntimeFixture(target, {
    workerSecrets: JSON.parse(secrets.stdout),
    async prepare(descriptor, output) {
      proof = await prepare({ descriptor, providers: [], metadata }, output);
      proofPath = path.join(output, 'sba-release.json');
      return { directory: path.join(output, 'publish'), manifestSha256: sha256(await fs.readFile(proofPath)) };
    },
    async verify(directory, digest) {
      assert.equal(sha256(await fs.readFile(proofPath)), digest);
      return verifyStampedRelease(directory, proofPath, digest, proof.metadata);
    }
  });
}, { timeout: 180000 });
after(async () => {
  if (fixture) { console.log('SBA local packaged evidence: ' + fixture.directory); await fixture.close(); }
}, { timeout: 30000 });

test('Python bootstrap uses real dual-Worker secrets, upstream DB version, registration KDF, admin login and authenticated self probe', { timeout: 90000 }, async () => {
  const routes = [], errors = [];
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')), url = new URL(input.url);
      routes.push({ method: input.method, origin: url.origin, path: url.pathname });
      let result;
      if (url.origin === 'https://api.cloudflare.com') {
        assert.equal(input.method, 'POST');
        const role = ['email', 'platform'].find(role => url.pathname === `/client/v4/accounts/${configuration.accountId}/d1/database/${configuration[role].database.id}/query`);
        assert.ok(role, 'unexpected cloud query target');
        const value = JSON.parse(Buffer.from(input.body, 'base64').toString('utf8'));
        const query = await (role === 'email' ? fixture.emailDb : fixture.db).prepare(value.sql).bind(...value.params).all();
        result = new Response(JSON.stringify({ success: true, errors: [], result: [{ success: true, results: query.results, meta: query.meta }] }));
      } else {
        assert.ok([fixture.target.email.origin, fixture.target.platform.origin].includes(url.origin));
        const options = { method: input.method, headers: input.headers, body: input.body === null ? undefined : Buffer.from(input.body, 'base64') };
        result = url.origin === fixture.target.email.origin ? await fixture.emailRequest(url.pathname, options) : await fixture.dispatch(url.href, options);
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: result.status, headers: Object.fromEntries(result.headers), body: Buffer.from(await result.arrayBuffer()).toString('base64') }));
    } catch (error) { errors.push(error.message); response.statusCode = 500; response.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const operation = path.join(fixture.directory, 'bootstrap'); await fs.mkdir(operation);
  try {
    const result = await promisify(execFile)('python', [driver, 'bootstrap', configurationPath, String(server.address().port), operation],
      { timeout: 60000, windowsHide: true, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    assert.equal(JSON.parse(result.stdout).status, 'passed'); assert.equal(JSON.parse(result.stdout).pristineRepairGatePassed, true); assert.deepEqual(errors, []);
    assert.equal((await fixture.db.prepare('SELECT COUNT(*) AS n FROM platform_admins').first()).n, 1);
    assert.equal((await fixture.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL').first()).n, 0);
    assert.match((await fixture.db.prepare('SELECT password_hash FROM users WHERE username=?').bind(configuration.settings.adminUsername).first()).password_hash,
      /^scrypt\$16384\$8\$5\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
    assert.deepEqual(fixture.external, []); await fixture.checkIntegrity();
    await fs.writeFile(path.join(operation, 'runtime-checks.json'), JSON.stringify({ status: 'passed', routes, external: [], realMailSent: false }, null, 2) + '\n', 'utf8');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('real dual Workers expose fixed release evidence; Python public verify accepts exact Web bytes and rejects altered evidence', async () => {
  const responses = {};
  for (const role of ['email', 'platform']) {
    const base = fixture.target[role].origin;
    const paths = [releasePath, ...(role === 'email' ? ['/health_check'] : ['/healthz', '/api/v1/me',
      ...proof.markers.platform.assets.flatMap(row => row.verificationPath ? [row.path, row.verificationPath] : [row.path])])];
    for (const route of paths) {
      const response = role === 'email' ? await fixture.emailRequest(route) : await fixture.dispatch(route);
      if (route.endsWith('easyemail-entry.bin')) {
        assert.equal(response.headers.get('content-type'), 'application/octet-stream');
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      }
      responses[base + route] = { status: response.status, body: Buffer.from(await response.arrayBuffer()).toString('base64') };
    }
  }
  const base = fixture.target.platform.origin;
  assert.equal(responses[base + '/'].body, responses[base + '/.well-known/easyemail-entry.bin'].body);
  const selected = { schemaVersion: 3, taskId: 'dc-' + '1'.repeat(32), action: 'verify', repository: 'aiaimimi0920/EasyEmail',
    sourceSha: proof.metadata.sourceSha, applicationId: 'easyemail', applicationVersion: '1.0.0', environment: 'local-test', configuration,
    previous: { sourceSha: proof.metadata.sourceSha, applicationVersion: '1.0.0' } };
  const input = path.join(fixture.directory, 'public-readbacks.json');
  await fs.writeFile(input, JSON.stringify({ selected, responses }), 'utf8');
  const code = `import base64,json,sys; from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]) / '.sba'))
from public_verify import verify_public
value=json.loads(Path(sys.argv[2]).read_text(encoding='utf8'))
def read(url,status=200,limit=8388608):
 row=value['responses'][url]; assert row['status']==status; body=base64.b64decode(row['body']); assert len(body)<=limit; return body
assert all(row['passed'] for row in verify_public(value['selected'],read))
value['selected']['sourceSha']='d'*40
from boundary import DeploymentError
try: verify_public(value['selected'],read)
except DeploymentError: pass
else: raise AssertionError('foreign release was accepted')
print('public-proof-passed')`;
  const result = spawnSync('python', ['-c', code, path.resolve('.'), input], { cwd: path.resolve('.'), encoding: 'utf8',
    timeout: 30000, windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /public-proof-passed/);
});

test('stamped email handler preserves native MIME delivery and aggregation without any external network writes', async () => {
  const user = await fixture.register('sba-local-user');
  const created = await fixture.allocate(user.cookie, 'sbacheck'); assert.equal(created.status, 201, created.text);
  const box = created.body.mailbox;
  assert.equal((await fixture.deliver(box.address, mime(box.address, '583219'))).rejectReason, undefined);
  const sync = await fixture.request(`/api/v1/mailboxes/${box.id}/sync`, { method: 'POST', cookie: user.cookie, body: {} });
  assert.equal(sync.status, 200, sync.text); assert.equal(sync.body.sync.inserted, 1);
  const messages = await fixture.request(`/api/v1/mailboxes/${box.id}/messages`, { cookie: user.cookie });
  assert.equal(messages.status, 200); assert.equal(messages.body.items.length, 1);
  await fixture.checkIntegrity(); assert.deepEqual(fixture.external, []);
  assert.deepEqual(fixture.configs.platform.triggers.crons, []);
  assert.equal(fixture.configs.email.send_email, undefined);
});

test('real stamped platform keeps object control opaque without its independent deployment secret', async () => {
  const response = await fixture.dispatch('/__easyemail_sba/v1/objects?bucket=OUTBOX');
  assert.equal(response.status, 404); assert.deepEqual(await response.json(), { error: 'not_found' });
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.deepEqual(fixture.external, []);
});

test('native same-instance data survives encrypted backup, migration/restart and existing-admin acceptance without mailbox or attachment loss', { timeout: 120000 }, async () => {
  const user = await fixture.register('sba-upgrade-user'), bytes = Buffer.from('native upgrade attachment\0邮件');
  const allocated = await fixture.allocate(user.cookie, 'sbaupgrade'); assert.equal(allocated.status, 201, allocated.text);
  const mailbox = allocated.body.mailbox;
  await fixture.deliver(mailbox.address, mime(mailbox.address, '971246'));
  assert.equal((await fixture.request(`/api/v1/mailboxes/${mailbox.id}/sync`, { method: 'POST', cookie: user.cookie, body: {} })).status, 200);
  const reserved = await fixture.request('/api/v1/outbox-attachments', { method: 'POST', cookie: user.cookie,
    headers: { 'idempotency-key': crypto.randomUUID() }, body: { filename: 'upgrade.bin', mimeType: 'application/octet-stream', size: bytes.length, sha256: sha256(bytes) } });
  assert.equal(reserved.status, 201, reserved.text); const id = reserved.body.attachment.id;
  const uploaded = await fixture.dispatch(`/api/v1/outbox-attachments/${id}/content`, { method: 'PUT', body: bytes,
    headers: { Origin: configuration.platform.origin, Cookie: user.cookie, 'content-type': 'application/octet-stream' } });
  assert.equal(uploaded.status, 200, await uploaded.clone().text());
  const before = await fixture.db.prepare('SELECT id,password_hash FROM users ORDER BY id').all();
  const raw = await fixture.emailDb.prepare('SELECT id,hex(raw_blob) AS bytes FROM raw_mails ORDER BY id').all();
  assert.ok(raw.results.length > 0);
  const bridge = await upgradeRuntimeBridge(fixture, configuration);
  try {
    const result = await promisify(execFile)('python', [path.resolve('.sba/tests/update-runtime-driver.py'), configurationPath, String(bridge.port), path.join(fixture.directory, 'upgrade')],
      { timeout: 110000, windowsHide: true, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.status, 'passed'); assert.equal(receipt.cloudDeployment, false);
    assert.deepEqual(bridge.errors, []); assert.equal(bridge.upgrades, 1); assert.equal(bridge.exports, 6);
    assert.deepEqual((await fixture.db.prepare('SELECT id,password_hash FROM users ORDER BY id').all()).results, before.results);
    assert.deepEqual((await fixture.emailDb.prepare('SELECT id,hex(raw_blob) AS bytes FROM raw_mails ORDER BY id').all()).results, raw.results);
    const read = await fixture.dispatch(`/api/v1/outbox-attachments/${id}/content`, { headers: { Cookie: user.cookie } });
    assert.equal(read.status, 200); assert.deepEqual(Buffer.from(await read.arrayBuffer()), bytes);
    const sync = await fixture.request(`/api/v1/mailboxes/${mailbox.id}/sync`, { method: 'POST', cookie: user.cookie, body: {} });
    assert.equal(sync.status, 200, sync.text); assert.equal(sync.body.sync.inserted, 0);
    const messages = await fixture.request(`/api/v1/mailboxes/${mailbox.id}/messages`, { cookie: user.cookie });
    assert.equal(messages.status, 200); assert.equal(messages.body.items.length, 1);
    assert.deepEqual(fixture.external, []); await fixture.checkIntegrity();
    await fs.writeFile(path.join(fixture.directory, 'upgrade-receipt.json'), JSON.stringify({ ...receipt, routes: bridge.routes, realMailSent: false }, null, 2), 'utf8');
  } finally { await bridge.close(); }
});
