import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { mkdtemp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const maintenance = ['cleanupIdentity', 'maintainGoogleOAuth', 'expirePendingSends', 'maintainNormalOutgoing',
  'scheduledOutboxCleanup', 'scheduledRetention', 'maintainNormalInbox', 'maintainAgentInbox'];
const minute = ['runSendJobs', 'runAgentTasks', 'runAgentFollowups', 'runAgentAutoInbox'];
const modules = { 'rate-limits': 'cleanupIdentity', 'google-oauth-maintenance': 'maintainGoogleOAuth',
  'outgoing-store': 'expirePendingSends', 'normal-outgoing-store': 'maintainNormalOutgoing',
  'outbox-cleanup': 'scheduledOutboxCleanup', 'retention-run': 'scheduledRetention',
  'normal-inbox-cleanup': 'maintainNormalInbox', 'agent-inbox-cleanup': 'maintainAgentInbox',
  'send-job-runner': 'runSendJobs', 'agent-task-runner': 'runAgentTasks',
  'agent-followup-runner': 'runAgentFollowups', 'agent-auto-inbox-runner': 'runAgentAutoInbox' };
const sensitive = 'https://private.example.test/?token=must-not-be-logged';
let worker;
before(async () => {
  assert.ok(process.env.EASYEMAIL_TEST_ROOT); await mkdir(process.env.EASYEMAIL_TEST_ROOT, { recursive: true });
  const directory = await mkdtemp(path.join(process.env.EASYEMAIL_TEST_ROOT, 'scheduled-')), outfile = path.join(directory, 'worker.mjs');
  await build({ entryPoints: [path.join(root, 'src/worker.ts')], outfile, bundle: true, format: 'esm', platform: 'node', plugins: [{
    name: 'test-only-scheduled-failures', setup(builder) {
      builder.onResolve({ filter: /^\.\// }, args => {
        // Only the production orchestration boundary is replaced; nested real adapters retain their original exports.
        const owner = path.relative(path.join(root, 'src'), args.importer).replaceAll('\\', '/');
        const symbol = modules[args.path.slice(2)];
        if (['worker.ts', 'scheduled-maintenance.ts'].includes(owner) && symbol) return { path: symbol, namespace: 'scheduled-fixture' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'scheduled-fixture' }, args => ({ resolveDir: root, contents: `
        ${args.path === 'cleanupIdentity' ? `export { rateLimit } from ${JSON.stringify(path.join(root, 'src/rate-limits.ts'))};` : ''}
        export async function ${args.path}(env, scheduledTime) {
          if (env.running) throw Error('overlapping scheduled steps');
          env.running = true; env.calls.push({ name: ${JSON.stringify(args.path)}, scheduledTime });
          try { await Promise.resolve(); if (env.failures.includes(${JSON.stringify(args.path)})) throw Error(env.sensitive); }
          finally { env.running = false; }
        }` }));
      builder.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({ path: 'sockets', namespace: 'blocked-sockets' }));
      builder.onLoad({ filter: /.*/, namespace: 'blocked-sockets' }, () => ({ contents: `export function connect() { throw Error('Unexpected network in orchestration test'); }` }));
    },
  }] });
  worker = (await import(pathToFileURL(outfile))).default;
});

async function scheduled(failures = [], cron = '*/15 * * * *') {
  const env = { calls: [], failures, running: false, sensitive }, logs = [], previous = console.error;
  let error;
  console.error = (...args) => logs.push(args.join(' '));
  try { await worker.scheduled({ cron, scheduledTime: 1793480400000 }, env); }
  catch (caught) { error = caught; }
  finally { console.error = previous; }
  assert.equal(env.running, false);
  return { calls: env.calls, logs, error };
}

test('maintenance retains the original serial order, scheduled timestamp and successful return', async () => {
  const result = await scheduled();
  assert.deepEqual(result.calls.map(row => row.name), maintenance);
  assert.equal(result.calls.find(row => row.name === 'scheduledRetention').scheduledTime, 1793480400000);
  assert.equal(result.error, undefined); assert.deepEqual(result.logs, []);
});

for (const failed of maintenance) test(`maintenance failure does not starve any other task: ${failed}`, async () => {
  const result = await scheduled([failed]);
  assert.deepEqual(result.calls.map(row => row.name), maintenance);
  assert.equal(result.error?.message, 'scheduled_maintenance_failed');
  assert.deepEqual(result.logs.map(value => JSON.parse(value)), [{ event: 'scheduled_maintenance_failed', task: failed }]);
  assert.ok(!JSON.stringify(result.logs).includes(sensitive));
  assert.ok(!String(result.error?.stack).includes('must-not-be-logged'));
});

test('multiple failures are reported separately without retrying or masking later maintenance', async () => {
  const failures = [maintenance[0], maintenance[3], maintenance[7]], result = await scheduled(failures);
  assert.deepEqual(result.calls.map(row => row.name), maintenance);
  assert.equal(result.error?.message, 'scheduled_maintenance_failed');
  assert.deepEqual(result.logs.map(value => JSON.parse(value)), failures.map(task => ({ event: 'scheduled_maintenance_failed', task })));
});

test('the per-minute dispatch branch stays separate and keeps its existing best-effort ordering', async () => {
  for (const failures of [[], [minute[0]], [minute[2]]]) {
    const result = await scheduled(failures, '* * * * *');
    assert.deepEqual(result.calls.map(row => row.name), minute); assert.deepEqual(result.logs, []);
    assert.equal(result.error?.message, failures.length ? sensitive : undefined);
  }
});
