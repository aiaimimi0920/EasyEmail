import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { test } from 'node:test';
import { deploymentPlan } from '../scripts/deployment-config.mjs';

const target = JSON.parse(await fs.readFile(new URL('../deployment.production.json', import.meta.url), 'utf8'));

test('production uses the requested Web origin and root mailbox domain with distinct fresh resources', async () => {
  assert.equal(target.platform.origin, 'https://mail.aiaimimi.com');
  assert.equal(target.email.origin, 'https://email-api.aiaimimi.com');
  assert.deepEqual(target.email.domains, ['aiaimimi.com']);
  for (const component of ['email', 'platform']) {
    assert.match(target[component].name, /^easyemail-production-/);
    assert.match(target[component].database.name, /^easyemail-production-/);
    assert.ok(!['b3a1247a-62cb-4616-a322-d36634f6e4d1', 'e67c1a6c-f084-4adb-a1bb-9abc54efba9f', '6208adc3-5b07-4a60-9efa-613d3ca1580d'].includes(target[component].database.id));
  }
  assert.match(target.platform.inboxBucket, /^easyemail-production-/);
  assert.match(target.platform.outboxBucket, /^easyemail-production-/);
  const plan = await deploymentPlan(target);
  assert.equal(plan.platform.vars.APP_ORIGIN, target.platform.origin);
  assert.deepEqual(plan.platform.routes, [{ pattern: 'mail.aiaimimi.com', custom_domain: true }]);
  assert.deepEqual(plan.email.routes, [{ pattern: 'email-api.aiaimimi.com', custom_domain: true }]);
  assert.equal(plan.platform.workers_dev, false);
  assert.equal(plan.email.workers_dev, false);
  assert.equal(plan.platform.preview_urls, false);
  assert.equal(plan.email.preview_urls, false);
});

test('production retains invitation-capable secrets, explicit sending destinations and scheduled maintenance', async () => {
  const plan = await deploymentPlan(target);
  assert.ok(plan.optionalSecrets.platform.includes('REGISTRATION_TOKEN'));
  assert.deepEqual(plan.platform.triggers.crons, ['* * * * *', '*/15 * * * *']);
  assert.deepEqual(plan.email.triggers.crons, ['0 0 * * *']);
  assert.ok(target.email.sendRecipients.length > 0);
  assert.ok(!target.email.sendRecipients.includes('*'));
  assert.deepEqual(plan.email.send_email[0].allowed_destination_addresses, target.email.sendRecipients);
  assert.deepEqual(plan.email.vars.SEND_MAIL_DOMAINS, ['aiaimimi.com']);
  const self = JSON.parse(plan.platform.vars.PROVIDER_CONFIG)[0];
  assert.equal(self.baseUrl, target.email.origin);
  assert.equal(self.sendTransport, 'binding');
  assert.deepEqual(JSON.parse(plan.platform.vars.PROVIDER_ENDPOINT_ORIGINS), [target.email.origin, 'https://api.temporam.com']);
  assert.deepEqual(JSON.parse(plan.platform.vars.IMAP_ENDPOINTS), []);
  assert.deepEqual(JSON.parse(plan.platform.vars.SMTP_ENDPOINTS), []);
});
