import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { newKey } from './runtime-harness.mjs';
import { attachmentMail, downloadPath } from './attachment-fixture.mjs';
import { mime } from './upstream-fixture.mjs';
import { releaseRuntimeFixture } from './release-runtime-fixture.mjs';

let f, alice, bob;
before(async () => { f = await releaseRuntimeFixture(); alice = await f.register('release-alice'); bob = await f.register('release-bob'); }, { timeout: 180000 });
after(async () => { if (f) { console.log(`Packaged runtime evidence: ${f.directory}`); await f.close(); } }, { timeout: 30000 });
const request = (route, options = {}) => f.request(route, { cookie: alice.cookie, ...options });
const sync = box => request(`/api/v1/mailboxes/${box.id}/sync`, { method: 'POST', body: {} });
const list = box => request(`/api/v1/mailboxes/${box.id}/messages`);

test('relocated release bundles serve Web and isolate sessions, Origin, scoped keys and disabled upstream injection', async () => {
  const response = await f.dispatch('/'); assert.equal(response.status, 200); assert.match(await response.text(), /assets\/app\.js/);
  assert.match((await request('/api/v1/me')).body.user.username, /release-alice/);
  const foreign = await request('/api/v1/auth/login', { method: 'POST', origin: 'https://foreign.example.com', body: {} }); assert.equal(foreign.status, 403);
  const denied = await f.request('/api/v1/mailboxes', { cookie: undefined }); assert.equal(denied.status, 401);
  const secretResponse = await f.dispatch('/.dev.vars'); assert.equal(secretResponse.status, 404);
  assert.equal(f.configs.email.vars.E2E_TEST_MODE, undefined);
  assert.equal(f.configs.email.vars.DISABLE_ADMIN_PASSWORD_CHECK, false);
  assert.equal(f.configs.email.send_email, undefined, 'Sending requires a separately authorized recipient allowlist');
  const injection = await f.emailRequest('/admin/test/receive_mail', { method: 'POST', headers: {
    'x-admin-auth': 'synthetic-release-admin-password', 'x-custom-auth': 'synthetic-release-site-password', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(injection.status, 404);
});

test('packaged complete Workers create random and exact mailboxes, ingest native MIME, sync once and extract a verification code', async () => {
  const random = await f.allocate(alice.cookie); assert.equal(random.status, 201, random.text);
  const created = await f.allocate(alice.cookie, 'releaseexact'); assert.equal(created.status, 201, created.text);
  const box = created.body.mailbox; assert.equal(box.address, `releaseexact@${f.target.email.domains[0]}`);
  assert.notEqual(random.body.mailbox.address, box.address);
  assert.ok(await f.emailDb.prepare('SELECT id FROM address WHERE name=?').bind(box.address).first());
  assert.equal((await f.deliver(box.address, mime(box.address, '839517'))).rejectReason, undefined);
  const synced = await sync(box); assert.equal(synced.status, 200, synced.text); assert.equal(synced.body.sync.inserted, 1);
  assert.equal((await sync(box)).body.sync.inserted, 0);
  const message = (await list(box)).body.items[0], detailRoute = `/api/v1/mailboxes/${box.id}/messages/${message.id}`;
  const detail = await request(detailRoute); assert.match(detail.body.message.textBody, /839517/);
  const extraction = await request(`/api/v1/mailboxes/${box.id}/extractions?since=1&sender=noreply&subject=verify`);
  assert.equal(extraction.body.items[0].otp.code, '839517', extraction.text);
  assert.equal((await request(detailRoute, { cookie: bob.cookie })).status, 404);
  const reader = await newKey(f, alice.cookie, { scopes: ['messages:read'] });
  assert.equal((await request(detailRoute, { token: reader.token, cookie: undefined, origin: null })).status, 200);
  assert.equal((await request(`/api/v1/mailboxes/${box.id}/sync`, { method: 'POST', token: reader.token, cookie: undefined, origin: null, body: {} })).status, 403);
  const boxReader = await newKey(f, alice.cookie); assert.equal((await request(detailRoute, { token: boxReader.token, cookie: undefined, origin: null })).status, 403);
  await f.restart(); assert.equal((await list(box)).body.items[0].id, message.id);
  assert.equal((await request(detailRoute, { token: reader.token, cookie: undefined, origin: null })).status, 200);
});

test('packaged MIME preserves exact attachment bytes, private R2 bindings, durable state, both cron schedules and migration integrity', async () => {
  const created = await f.allocate(alice.cookie); assert.equal(created.status, 201, created.text); const box = created.body.mailbox;
  const mail = attachmentMail(box.address, Buffer.from([0, 255, 128, 33, 10, 13, 65, 0]));
  const raw = `Message-ID: <${crypto.randomUUID()}@example.test>\r\n${mail.raw.raw}`;
  assert.equal((await f.deliver(box.address, raw)).rejectReason, undefined); assert.equal((await sync(box)).status, 200);
  const message = (await list(box)).body.items[0];
  const detail = await request(`/api/v1/mailboxes/${box.id}/messages/${message.id}`);
  assert.equal(detail.body.message.attachments[0].downloadAvailable, true, detail.text);
  const route = downloadPath(box, message), downloaded = await f.dispatch(route, { headers: { cookie: alice.cookie } });
  assert.equal(downloaded.status, 200); assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), mail.bytes);
  assert.equal(downloaded.headers.get('cache-control'), 'no-store');
  assert.equal((await f.dispatch(route, { headers: { cookie: bob.cookie } })).status, 404);
  for (const binding of ['INBOX', 'OUTBOX']) {
    const bucket = await f.bucket(binding); await bucket.put('synthetic-release-probe', mail.bytes);
    assert.deepEqual(Buffer.from(await (await bucket.get('synthetic-release-probe')).arrayBuffer()), mail.bytes);
  }
  await f.scheduled(); await f.restart();
  for (const binding of ['INBOX', 'OUTBOX']) assert.deepEqual(Buffer.from(await (await (await f.bucket(binding)).get('synthetic-release-probe')).arrayBuffer()), mail.bytes);
  await f.checkIntegrity(); assert.ok(f.forwarded.some(row => row.path === '/api/parsed_mails'));
  assert.deepEqual(f.external, []);
});
