import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { test } from 'node:test';
import { deploymentPlan } from '../scripts/deployment-config.mjs';
import { deploymentFixture, acceptanceDeploymentFixture } from './deployment-config-fixture.mjs';

test('the aggregation Worker routes self-provider fetches through the public Cloudflare edge in every deployment mode', async () => {
  for (const value of [deploymentFixture(), acceptanceDeploymentFixture(), acceptanceDeploymentFixture(true)]) {
    const plan = await deploymentPlan(value);
    assert.deepEqual(plan.platform.compatibility_flags, ['nodejs_compat', 'global_fetch_strictly_public']);
    assert.deepEqual(plan.email.compatibility_flags, ['nodejs_compat']);
  }
});

test('a dual-service plan wires distinct D1 databases, private R2 buckets, API origin, assets and required schedules without secrets or writes', async () => {
  const value = deploymentFixture(), plan = await deploymentPlan(value);
  assert.equal(plan.status, 'planned-not-deployed'); assert.equal(plan.remoteResourcesVerified, false); assert.equal(plan.remoteWrites, false);
  assert.equal(plan.platform.vars.APP_ORIGIN, value.platform.origin); assert.equal(plan.email.routes[0].pattern, 'email-api.release.example.com');
  assert.deepEqual(plan.platform.assets, { directory: './web', binding: 'ASSETS', run_worker_first: true });
  assert.deepEqual(plan.platform.triggers.crons, ['* * * * *', '*/15 * * * *']);
  assert.deepEqual(plan.platform.r2_buckets.map(row => row.binding), ['INBOX', 'OUTBOX']);
  assert.equal(plan.platform.d1_databases[0].database_id, value.platform.database.id); assert.equal(plan.email.d1_databases[0].database_id, value.email.database.id);
  assert.equal(plan.email.vars.DISABLE_ADMIN_PASSWORD_CHECK, false); assert.equal(plan.email.vars.DISABLE_ANONYMOUS_USER_CREATE_EMAIL, true);
  assert.equal(plan.email.send_email, undefined); assert.equal(JSON.parse(plan.platform.vars.PROVIDER_CONFIG)[0].sendTransport, undefined);
  assert.deepEqual(plan.requiredSecrets.platform, ['MAILBOX_KEYRING', 'PROVIDER_SECRETS']); assert.deepEqual(plan.requiredSecrets.email, ['JWT_SECRET', 'PASSWORDS', 'ADMIN_PASSWORDS']);
  for (const key of [...plan.requiredSecrets.platform, ...plan.requiredSecrets.email]) assert.equal(Object.hasOwn(plan.platform.vars, key) || Object.hasOwn(plan.email.vars, key), false);
});

test('strict target validation rejects credentials, unknown fields, placeholder identities, shared resources and unsafe endpoints', async () => {
  const invalid = [v => { v.apiKey = 'must-not-be-read'; }, v => { v.email.vars = { JWT_SECRET: 'must-not-be-read' }; },
    v => { v.accountId = '0'.repeat(32); }, v => { v.email.database.id = '00000000-0000-0000-0000-000000000000'; },
    v => { v.email.database.id = v.platform.database.id; }, v => { v.email.database.name = v.platform.database.name; },
    v => { v.email.name = v.platform.name; }, v => { v.email.origin = v.platform.origin; },
    v => { v.platform.inboxBucket = v.platform.outboxBucket; }, v => { v.platform.origin = 'http://127.0.0.1:8787'; },
    v => { v.email.origin = 'https://user:secret@email-api.release.example.com'; }, v => { v.email.origin += '/private'; },
    v => { v.email.origin += '?token=must-not-be-read'; }, v => { v.email.domains = ['*.release.example.com']; },
    v => { v.email.domains.push(v.email.domains[0]); }, v => { v.platform.inboxBucket = '../outside'; }];
  for (const change of invalid) {
    const value = deploymentFixture(); change(value);
    await assert.rejects(deploymentPlan(value), error => { assert.equal(error.message.includes('must-not-be-read'), false); return true; });
  }
});

test('optional native sending couples the same explicit destinations to both services and never enables unrestricted sending', async () => {
  const value = deploymentFixture(); value.email.sendRecipients = ['recipient@example.com']; const plan = await deploymentPlan(value);
  assert.deepEqual(plan.email.send_email, [{ name: 'SEND_MAIL', allowed_destination_addresses: ['recipient@example.com'] }]);
  assert.deepEqual(plan.email.vars.SEND_MAIL_DOMAINS, value.email.domains);
  const provider = JSON.parse(plan.platform.vars.PROVIDER_CONFIG)[0]; assert.equal(provider.sendTransport, 'binding'); assert.deepEqual(provider.sendRecipients, value.email.sendRecipients);
  for (const recipients of [['*'], ['invalid'], ['recipient@example.com', 'recipient@example.com']]) {
    value.email.sendRecipients = recipients; await assert.rejects(deploymentPlan(value));
  }
});

test('deployment endpoint validation reuses the production IMAP, SMTP, OAuth and provider policy rather than accepting permissive JSON', async () => {
  const value = deploymentFixture(); value.platform.imapEndpoints = [{ id: 'gmail', label: 'Google IMAP', hostname: 'imap.gmail.com', port: 993, authentication: 'google-oauth2' }];
  value.platform.smtpEndpoints = [{ id: 'gmail', label: 'Google SMTP', hostname: 'smtp.gmail.com', port: 587, security: 'starttls', authentication: 'google-oauth2', recipients: ['recipient@example.com'] }];
  value.platform.providerEndpointOrigins = ['https://provider.example.com']; const plan = await deploymentPlan(value);
  assert.deepEqual(JSON.parse(plan.platform.vars.IMAP_ENDPOINTS), value.platform.imapEndpoints);
  assert.deepEqual(plan.optionalSecrets.platform, ['REGISTRATION_TOKEN', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET']);
  value.platform.imapEndpoints[0].hostname = 'private.internal'; await assert.rejects(deploymentPlan(value));
  value.platform.imapEndpoints = []; value.platform.smtpEndpoints[0].port = 25; await assert.rejects(deploymentPlan(value));
});

test('isolated acceptance plans remain closed, unscheduled, invitation-only and unable to send real mail', async () => {
  const value = acceptanceDeploymentFixture(), plan = await deploymentPlan(value);
  assert.deepEqual(JSON.parse(await fs.readFile(new URL('../deployment.acceptance.example.json', import.meta.url), 'utf8')), value);
  assert.equal(plan.status, 'planned-not-deployed'); assert.equal(plan.remoteWrites, false); assert.equal(plan.mode, 'isolated-acceptance');
  for (const component of ['email', 'platform']) {
    assert.equal(plan[component].workers_dev, false); assert.equal(plan[component].preview_urls, false);
    assert.deepEqual(plan[component].routes, []); assert.deepEqual(plan[component].triggers.crons, []);
  }
  assert.deepEqual(plan.requiredSecrets.platform, ['MAILBOX_KEYRING', 'PROVIDER_SECRETS', 'REGISTRATION_TOKEN']);
  assert.deepEqual(plan.optionalSecrets.platform, []); assert.equal(plan.email.send_email, undefined);
  assert.deepEqual(JSON.parse(plan.platform.vars.IMAP_ENDPOINTS), []); assert.deepEqual(JSON.parse(plan.platform.vars.SMTP_ENDPOINTS), []);
  const provider = JSON.parse(plan.platform.vars.PROVIDER_CONFIG)[0];
  assert.deepEqual(provider.domains, ['mail.acceptance.test']); assert.deepEqual(provider.sendRecipients, []); assert.equal(provider.sendTransport, undefined);
});

test('workers.dev exposure must be explicitly requested in an isolated plan and never implies deployment or preview access', async () => {
  const plan = await deploymentPlan(acceptanceDeploymentFixture(true));
  assert.equal(plan.remoteWrites, false); assert.equal(plan.platform.workers_dev, true); assert.equal(plan.email.workers_dev, true);
  assert.equal(plan.platform.preview_urls, false); assert.equal(plan.email.preview_urls, false);
  assert.deepEqual(plan.platform.routes, []); assert.deepEqual(plan.email.routes, []);
});

test('isolated acceptance rejects production names, mismatched workers.dev origins, real domains and external mail endpoints', async () => {
  const invalid = [v => { delete v.acceptance; }, v => { v.acceptance = null; }, v => { v.acceptance = {}; }, v => { v.acceptance.workersDev = 'false'; },
    v => { v.acceptance.routes = []; }, v => { v.acceptance.token = 'must-not-be-read'; },
    v => { v.email.name = 'production-email'; }, v => { v.platform.name = 'production-platform'; },
    v => { v.email.database.name = 'production-db'; }, v => { v.platform.database.name = 'production-db'; },
    v => { v.platform.inboxBucket = 'production-inbox'; }, v => { v.platform.outboxBucket = 'production-outbox'; },
    v => { v.email.origin = 'https://email.production.example.com'; },
    v => { v.platform.origin = 'https://other.synthetic-account.workers.dev'; },
    v => { v.platform.origin = 'https://easyemail-migration-platform.another-account.workers.dev'; },
    v => { v.email.origin = 'https://easyemail-migration-email.synthetic-account.workers.dev.evil.example.com'; },
    v => { v.email.domains = ['mail.production.example.com']; }, v => { v.email.domains = ['mail.test.evil.example.com']; },
    v => { v.email.sendRecipients = ['recipient@example.com']; },
    v => { v.platform.providerEndpointOrigins = ['https://provider.example.com']; },
    v => { v.platform.imapEndpoints = [{ id: 'imap', label: 'IMAP', hostname: 'imap.example.com', port: 993 }]; },
    v => { v.platform.smtpEndpoints = [{ id: 'smtp', label: 'SMTP', hostname: 'smtp.example.com', port: 465, security: 'tls', recipients: ['recipient@example.com'] }]; }];
  for (const change of invalid) {
    const value = acceptanceDeploymentFixture(); change(value);
    await assert.rejects(deploymentPlan(value), error => { assert.equal(error.message.includes('must-not-be-read'), false); return true; });
  }
});
