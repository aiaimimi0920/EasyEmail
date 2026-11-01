import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
let readRecovery;
before(async () => {
  assert.ok(process.env.EASYEMAIL_TEST_ROOT); await mkdir(process.env.EASYEMAIL_TEST_ROOT, { recursive: true });
  const directory = await mkdtemp(path.join(process.env.EASYEMAIL_TEST_ROOT, 'recovery-view-')), outfile = path.join(directory, 'view.mjs');
  await build({ entryPoints: [fileURLToPath(new URL('../web/mailbox-access-recovery.ts', import.meta.url))], outfile, bundle: true, format: 'esm', platform: 'neutral' });
  ({ readRecovery } = await import(pathToFileURL(outfile)));
});
const receipt = { requestKey: crypto.randomUUID(), mailboxId: crypto.randomUUID(), providerId: 'self', address: 'proof@example.test', mode: 'imported', createdAt: 123 };
const input = { providerId: receipt.providerId, address: receipt.address };
for (const [label, patch] of [['key', { requestKey: crypto.randomUUID() }], ['provider', { providerId: 'other' }],
  ['address', { address: 'other@example.test' }], ['mailbox', { mailboxId: 'bad' }], ['mode', { mode: 'pending' }],
  ['time', { createdAt: -1 }], ['missing time', { createdAt: undefined }], ['numeric time', { createdAt: '123' }]]) {
  test(`recovery receipt rejects mismatched ${label}`, () => {
    assert.throws(() => readRecovery({ recovery: { ...receipt, ...patch } }, receipt.requestKey, input), /mailbox_recovery_response_invalid/);
  });
}
test('key-only reads still validate the receipt structure without inventing current mailbox usability', () => {
  for (const mode of ['imported', 'restored', 'refreshed']) {
    const value = { ...receipt, mode }; assert.deepEqual(readRecovery({ recovery: value }, receipt.requestKey, input), value);
    assert.deepEqual(readRecovery({ recovery: value }, receipt.requestKey), value);
  }
  for (const patch of [{ address: 'bad' }, { providerId: '../self' }, { mailboxId: 'bad' }, { mode: 'unknown' }]) {
    assert.throws(() => readRecovery({ recovery: { ...receipt, ...patch } }, receipt.requestKey), /mailbox_recovery_response_invalid/);
  }
  assert.throws(() => readRecovery(null, receipt.requestKey), /mailbox_recovery_response_invalid/);
});
