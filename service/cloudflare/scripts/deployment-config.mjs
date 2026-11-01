import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const invalid = field => { throw Error(`Invalid deployment field: ${field}`); };
function record(value, fields, at) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some(key => !fields.includes(key))) invalid(at);
  return value;
}
function name(value, at) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value)) invalid(at);
  return value;
}
function origin(value, at) {
  try {
    const url = new URL(value);
    if (typeof value !== 'string' || url.protocol !== 'https:' || url.origin !== value || url.port
      || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname)
      || /(?:\.home\.arpa$|(?:^|\.)(?:localhost|local|localdomain|internal|lan|home|onion|invalid)$)/.test(url.hostname)) invalid(at);
    return value;
  } catch { invalid(at); }
}
function database(value, at) {
  const row = record(value, ['name', 'id'], at);
  if (typeof row.id !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(row.id) || row.id.replaceAll('-', '') === '0'.repeat(32)) invalid(at);
  return { name: name(row.name, at), id: row.id };
}
function array(value, at, maximum) {
  if (!Array.isArray(value) || value.length > maximum) invalid(at); return value;
}
function isolatedAcceptance(value, email, platform) {
  if (!Object.hasOwn(value, 'acceptance')) return null;
  const settings = record(value.acceptance, ['workersDev'], 'acceptance');
  if (typeof settings.workersDev !== 'boolean') invalid('acceptance.workersDev');
  const names = [email.name, platform.name, email.database.name, platform.database.name, platform.inboxBucket, platform.outboxBucket];
  if (names.some(name => !name.startsWith('easyemail-migration-'))) invalid('acceptance resource prefix');
  const subdomains = [email, platform].map(component => {
    const labels = new URL(component.origin).hostname.split('.');
    if (labels.length !== 4 || labels[0] !== component.name || labels[2] !== 'workers' || labels[3] !== 'dev') invalid('acceptance origin');
    return labels[1];
  });
  if (subdomains[0] !== subdomains[1]) invalid('acceptance account subdomain');
  return settings;
}
let validators;
async function productionValidators() {
  validators ??= build({ stdin: { contents: `export { imapEndpoints } from './src/normal-account-input';
    export { smtpEndpoints } from './src/smtp-config-input';
    export { environmentConfigs, endpointOrigins } from './src/providers/config';
    export { mailAddress, validDomain } from './src/mail-address';`, resolveDir: root },
    bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2022', logLevel: 'silent' })
    .then(result => import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`));
  return validators;
}

export async function deploymentPlan(input) {
  const value = record(input, ['version', 'accountId', 'email', 'platform', 'acceptance'], 'root');
  if (value.version !== 1 || typeof value.accountId !== 'string' || !/^[0-9a-f]{32}$/.test(value.accountId) || /^0+$/.test(value.accountId)) invalid('version/accountId');
  const e = record(value.email, ['name', 'origin', 'domains', 'database', 'sendRecipients'], 'email');
  const p = record(value.platform, ['name', 'origin', 'database', 'inboxBucket', 'outboxBucket', 'imapEndpoints', 'smtpEndpoints', 'providerEndpointOrigins'], 'platform');
  const email = { name: name(e.name, 'email.name'), origin: origin(e.origin, 'email.origin'), database: database(e.database, 'email.database') };
  const platform = { name: name(p.name, 'platform.name'), origin: origin(p.origin, 'platform.origin'), database: database(p.database, 'platform.database'),
    inboxBucket: name(p.inboxBucket, 'platform.inboxBucket'), outboxBucket: name(p.outboxBucket, 'platform.outboxBucket') };
  if (email.name === platform.name || email.origin === platform.origin || email.database.name === platform.database.name
    || email.database.id === platform.database.id || platform.inboxBucket === platform.outboxBucket) invalid('resource isolation');
  const acceptance = isolatedAcceptance(value, email, platform);
  if (!acceptance && [email, platform].some(component => new URL(component.origin).hostname.endsWith('.workers.dev'))) invalid('workers.dev requires acceptance mode');
  const validators = await productionValidators(), domains = array(e.domains, 'email.domains', 100), recipients = array(e.sendRecipients ?? [], 'email.sendRecipients', 50);
  if (!domains.length || domains.some(domain => typeof domain !== 'string' || !validators.validDomain(domain)) || new Set(domains).size !== domains.length) invalid('email.domains');
  if (recipients.some(address => !validators.mailAddress(address) || address !== address.toLowerCase()) || new Set(recipients).size !== recipients.length) invalid('email.sendRecipients');
  const extraOrigins = array(p.providerEndpointOrigins ?? [], 'platform.providerEndpointOrigins', 19).map(value => origin(value, 'platform.providerEndpointOrigins'));
  const imap = array(p.imapEndpoints ?? [], 'platform.imapEndpoints', 20), smtp = array(p.smtpEndpoints ?? [], 'platform.smtpEndpoints', 20);
  if (acceptance && (domains.some(domain => !domain.endsWith('.test')) || recipients.length || extraOrigins.length || imap.length || smtp.length)) invalid('acceptance external mail policy');
  const provider = { id: 'self', type: 'cloudflare', baseUrl: email.origin, domains: [...domains], enabled: true, sendRecipients: [...recipients], ...(recipients.length ? { sendTransport: 'binding' } : {}) };
  const vars = { APP_ORIGIN: platform.origin, PROVIDER_CONFIG: JSON.stringify([provider]), PROVIDER_ENDPOINT_ORIGINS: JSON.stringify([...new Set([email.origin, ...extraOrigins])]),
    IMAP_ENDPOINTS: JSON.stringify(imap), SMTP_ENDPOINTS: JSON.stringify(smtp) };
  try { validators.imapEndpoints(vars); validators.smtpEndpoints(vars); validators.endpointOrigins(vars, validators.environmentConfigs(vars)); }
  catch { invalid('runtime endpoint/provider policy'); }
  const base = { account_id: value.accountId, compatibility_flags: ['nodejs_compat'], workers_dev: acceptance?.workersDev ?? false, preview_urls: false, keep_vars: false,
    no_bundle: true, find_additional_modules: true };
  const db = row => [{ binding: 'DB', database_name: row.name, database_id: row.id }];
  return { status: 'planned-not-deployed', remoteWrites: false, remoteResourcesVerified: false,
    ...(acceptance ? { mode: 'isolated-acceptance' } : {}),
    platform: { ...base, compatibility_flags: [...base.compatibility_flags, 'global_fetch_strictly_public'],
      name: platform.name, main: './server/worker.mjs', base_dir: './server', compatibility_date: '2026-10-23',
      routes: acceptance ? [] : [{ pattern: new URL(platform.origin).hostname, custom_domain: true }], assets: { directory: './web', binding: 'ASSETS', run_worker_first: true },
      triggers: { crons: acceptance ? [] : ['* * * * *', '*/15 * * * *'] }, vars, d1_databases: db(platform.database).map(row => ({ ...row, migrations_dir: './migrations' })),
      r2_buckets: [{ binding: 'INBOX', bucket_name: platform.inboxBucket }, { binding: 'OUTBOX', bucket_name: platform.outboxBucket }] },
    email: { ...base, name: email.name, main: './bundle/worker.js', base_dir: './bundle', compatibility_date: '2025-04-01',
      routes: acceptance ? [] : [{ pattern: new URL(email.origin).hostname, custom_domain: true }], triggers: { crons: acceptance ? [] : ['0 0 * * *'] }, d1_databases: db(email.database),
      vars: { DOMAINS: [...domains], DEFAULT_DOMAINS: [...domains], PREFIX: '', DISABLE_ADMIN_PASSWORD_CHECK: false, DISABLE_ANONYMOUS_USER_CREATE_EMAIL: true,
        ENABLE_USER_CREATE_EMAIL: true, ENABLE_USER_DELETE_EMAIL: true, ENABLE_MAIL_GZIP: true, ENABLE_AUTO_REPLY: false, ENABLE_WEBHOOK: false,
        ENABLE_ANOTHER_WORKER: false, ENABLE_AI_EMAIL_EXTRACT: false, ...(recipients.length ? { SEND_MAIL_DOMAINS: [...domains] } : {}) },
      ...(recipients.length ? { send_email: [{ name: 'SEND_MAIL', allowed_destination_addresses: [...recipients] }] } : {}) },
    requiredSecrets: { platform: ['MAILBOX_KEYRING', 'PROVIDER_SECRETS', ...(acceptance ? ['REGISTRATION_TOKEN'] : [])], email: ['JWT_SECRET', 'PASSWORDS', 'ADMIN_PASSWORDS'] },
    optionalSecrets: { platform: [...(acceptance ? [] : ['REGISTRATION_TOKEN']), ...(imap.some(row => row.authentication === 'google-oauth2') || smtp.some(row => row.authentication === 'google-oauth2')
      ? ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'] : [])] },
    remainingGates: acceptance ? ['Verify the six isolated resources, account ownership and billing; names alone do not prove isolation',
      'Approve schema, test secrets, bindings and deployment separately from resource creation',
      'Approve workers.dev exposure explicitly before enabling it; preview URLs remain disabled',
      'Use only synthetic users and mail; do not configure MX, Email Routing, real send bindings or production credentials',
      'Verify cloud Web/API, access isolation and logs after approved deployment; local dry-run is not cloud acceptance']
      : ['Confirm isolated account/resources/domains and billing', 'Provision resources only after explicit approval', 'Apply schema and migrations with backup/rollback review',
      'Set and verify secrets independently; never place values in the descriptor', 'Grant platform administrator explicitly after registration',
      'Configure Email Routing, authorized sending and OAuth where required', 'Deploy only after approval, then verify real Web/API, mail delivery and scheduled work'] };
}
