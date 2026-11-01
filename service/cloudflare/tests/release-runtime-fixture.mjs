import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { prepareRelease } from '../scripts/prepare-release.mjs';
import { verifyRelease } from '../scripts/release-artifacts.mjs';
import { deploymentFixture } from './deployment-config-fixture.mjs';
import { migrationStatements } from './migration-sql.mjs';

export const RELEASE_PASSWORD = 'Synthetic-release-password-735296';
export const RELEASE_INVITE = 'synthetic-release-invitation-32bytes-minimum';
const sitePassword = 'synthetic-release-site-password', adminPassword = 'synthetic-release-admin-password';
const expectedMigrations = 59;

// Only packaged production bundles run here. No test Worker, provider adapter or HTTP mail-injection route.
export async function releaseRuntimeFixture(target = deploymentFixture()) {
  const root = process.env.EASYEMAIL_TEST_ROOT;
  assert.ok(root && path.isAbsolute(root), 'Set an absolute isolated EASYEMAIL_TEST_ROOT');
  const directory = await fs.mkdtemp(path.join(root, 'rel-'));
  const prepared = await prepareRelease(target, path.join(directory, 'prepared'));
  const candidate = path.join(directory, 'moved'); await fs.cp(prepared.directory, candidate, { recursive: true });
  await verifyRelease(candidate, prepared.manifestSha256);
  const configs = Object.fromEntries(await Promise.all(['email', 'platform'].map(async component =>
    [component, JSON.parse(await fs.readFile(path.join(candidate, component, 'wrangler.json'), 'utf8'))])));
  const external = [], forwarded = [], state = path.join(directory, 's'); let email, platform, db, emailDb;
  const settings = component => ({ name: configs[component].name, modules: true, host: '127.0.0.1',
    scriptPath: path.resolve(candidate, component, configs[component].main), modulesRoot: path.resolve(candidate, component, configs[component].base_dir),
    compatibilityDate: configs[component].compatibility_date, compatibilityFlags: configs[component].compatibility_flags,
    d1Databases: { DB: configs[component].d1_databases[0].database_id }, resourcePersistencePath: path.join(state, component[0]),
    unsafeTriggerHandlers: true });
  const emailSettings = { ...settings('email'), bindings: { ...configs.email.vars,
    JWT_SECRET: 'synthetic-release-jwt-secret-32bytes-minimum', PASSWORDS: JSON.stringify([sitePassword]),
    ADMIN_PASSWORDS: JSON.stringify([adminPassword]) },
    outboundService(request) { external.push(request.url); return new Response('Unexpected external request', { status: 502 }); } };
  const platformSettings = { ...settings('platform'),
    assets: { directory: path.join(candidate, 'platform/web'), binding: configs.platform.assets.binding,
      routerConfig: { invoke_user_worker_ahead_of_assets: true, has_user_worker: true } },
    r2Buckets: Object.fromEntries(configs.platform.r2_buckets.map(row => [row.binding, row.bucket_name])),
    bindings: { ...configs.platform.vars, REGISTRATION_TOKEN: RELEASE_INVITE,
      MAILBOX_KEYRING: JSON.stringify({ active: 'k1', keys: { k1: 'a3'.repeat(32) } }),
      PROVIDER_SECRETS: JSON.stringify({ self: { apiKey: adminPassword, sitePassword } }) },
    async outboundService(request) {
      if (new URL(request.url).origin !== target.email.origin) { external.push(request.url); return new Response('Unexpected external request', { status: 502 }); }
      forwarded.push({ method: request.method, path: new URL(request.url).pathname });
      return email.dispatchFetch(request.url, { method: request.method, headers: request.headers,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer() });
    } };
  async function start() {
    const ready = async worker => {
      let timer;
      try { await Promise.race([worker.ready, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Packaged Worker startup exceeded 45s')), 45000); })]); }
      finally { clearTimeout(timer); }
    };
    email = new Miniflare(convertV4MiniflareOptions(emailSettings)); await ready(email); emailDb = await email.getD1Database('DB');
    platform = new Miniflare(convertV4MiniflareOptions(platformSettings)); await ready(platform); db = await platform.getD1Database('DB');
  }
  async function migrate() {
    await db.prepare('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)').run();
    const applied = [];
    for (const name of (await fs.readdir(path.join(candidate, 'platform/migrations'))).filter(file => file.endsWith('.sql')).sort()) {
      if (await db.prepare('SELECT id FROM d1_migrations WHERE name=?').bind(name).first()) continue;
      const sql = await fs.readFile(path.join(candidate, 'platform/migrations', name), 'utf8');
      await db.batch([...migrationStatements(sql).map(statement => db.prepare(statement)), db.prepare('INSERT INTO d1_migrations(name) VALUES (?)').bind(name)]);
      applied.push(name);
    }
    return applied;
  }
  async function close() {
    try { await platform?.dispose(); } finally { await email?.dispose(); }
    assert.deepEqual(external, [], 'All requests must remain within the two local Workers');
  }
  try {
    await start();
    const schema = await fs.readFile(path.join(candidate, 'email/schema.sql'), 'utf8');
    for (const sql of schema.trim().split(/\r?\n\s*\r?\n/)) await emailDb.prepare(sql).run();
    assert.equal((await migrate()).length, expectedMigrations); assert.deepEqual(await migrate(), []);
    return { directory, candidate, prepared, target, configs, external, forwarded,
      get db() { return db; }, get emailDb() { return emailDb; },
      async dispatch(route, options = {}) { return platform.dispatchFetch(new URL(route, target.platform.origin).href, options); },
      emailRequest(route, options = {}) { return email.dispatchFetch(new URL(route, target.email.origin).href, options); },
      async request(route, { method = 'GET', cookie, token, origin = target.platform.origin, body, headers = {} } = {}) {
        const h = new Headers(headers); if (origin !== null) h.set('origin', origin);
        if (cookie) h.set('cookie', cookie); if (token) h.set('authorization', `Bearer ${token}`);
        if (body !== undefined && !h.has('content-type')) h.set('content-type', 'application/json');
        const response = await this.dispatch(route, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
        const text = await response.text(); assert.match(response.headers.get('content-type') ?? '', /application\/json/, text);
        return { status: response.status, headers: response.headers, text, body: JSON.parse(text), cookie: response.headers.get('set-cookie')?.split(';')[0] };
      },
      async register(username) {
        const response = await this.request('/api/v1/auth/register', { method: 'POST', body: { username, password: RELEASE_PASSWORD, invite: RELEASE_INVITE } });
        assert.equal(response.status, 201, response.text); return { ...response.body.user, cookie: response.cookie };
      },
      allocate(cookie, prefix) { return this.request('/api/v1/mailboxes', { method: 'POST', cookie, headers: { 'idempotency-key': crypto.randomUUID() },
        body: { providerId: 'self', domain: target.email.domains[0], ...(prefix ? { prefix } : {}) } }); },
      async deliver(to, raw) {
        const params = new URLSearchParams({ format: 'json', from: 'noreply@example.test', to });
        const response = await email.dispatchFetch(`${(await email.ready).origin}/cdn-cgi/local/email?${params}`, {
          method: 'POST', headers: { 'content-type': 'message/rfc822' }, body: raw });
        const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.outcome, 'ok'); return body;
      },
      bucket: binding => platform.getR2Bucket(binding),
      async restart() { await platform.dispose(); await email.dispose(); await start(); },
      async checkIntegrity() {
        assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results, []);
        assert.deepEqual((await emailDb.prepare('PRAGMA foreign_key_check').all()).results, []);
        assert.equal((await db.prepare('SELECT COUNT(*) n FROM d1_migrations').first()).n, expectedMigrations);
        await verifyRelease(candidate, prepared.manifestSha256);
      },
      async scheduled() {
        for (const cron of configs.platform.triggers.crons) assert.equal((await (await platform.getWorker()).scheduled({ cron, scheduledTime: Date.now() })).outcome, 'ok');
        assert.equal((await (await email.getWorker()).scheduled({ cron: configs.email.triggers.crons[0], scheduledTime: Date.now() })).outcome, 'ok');
      },
      close };
  } catch (error) { await close(); throw error; }
}
