import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { encryptFile, decryptFile } from '../archive-crypto.mjs';

const key = 'a1'.repeat(32), context = 'b2'.repeat(32);
async function fixture() {
  const root = await fs.mkdtemp(path.join(process.env.EASYEMAIL_TEST_ROOT, 'sba-crypto-'));
  const input = path.join(root, 'input.bin'), encrypted = path.join(root, 'encrypted.bin');
  const bytes = Buffer.concat([Buffer.from('private SQL and 邮件\0'), randomBytes(150001)]);
  await fs.writeFile(input, bytes);
  await encryptFile(input, encrypted, key, context);
  return { root, input, encrypted, bytes };
}

test('AES-GCM roundtrip binds the snapshot identity, uses fresh nonces and preserves all bytes', async () => {
  const value = await fixture(), restored = path.join(value.root, 'restored.bin');
  await decryptFile(value.encrypted, restored, key, context);
  assert.deepEqual(await fs.readFile(restored), value.bytes);
  const second = path.join(value.root, 'second.bin');
  await encryptFile(value.input, second, key, context);
  const firstBytes = await fs.readFile(value.encrypted);
  assert.equal(firstBytes.includes(Buffer.from('private SQL')), false);
  assert.notDeepEqual(firstBytes, await fs.readFile(second));
});

test('wrong key, wrong identity, tampered ciphertext/tag/header and truncation never leave usable output', async () => {
  const value = await fixture(), bytes = await fs.readFile(value.encrypted);
  for (const [index, selected] of [0, 8, 52, bytes.length - 1, null].entries()) {
    const altered = selected === null ? bytes.subarray(0, 40) : Buffer.from(bytes);
    if (selected !== null) altered[selected] ^= 1;
    const input = path.join(value.root, `tampered-${index}`), output = path.join(value.root, `failed-${index}`);
    await fs.writeFile(input, altered);
    await assert.rejects(decryptFile(input, output, key, context), /EASYEMAIL_ARCHIVE_CRYPTO_FAILED/);
    await assert.rejects(fs.access(output));
  }
  for (const [selectedKey, selectedContext] of [['c3'.repeat(32), context], [key, 'd4'.repeat(32)]]) {
    const output = path.join(value.root, selectedKey.slice(0, 2) + selectedContext.slice(0, 2));
    await assert.rejects(decryptFile(value.encrypted, output, selectedKey, selectedContext), /EASYEMAIL_ARCHIVE_CRYPTO_FAILED/);
    await assert.rejects(fs.access(output));
  }
});

test('encryption and decryption refuse existing outputs without changing their bytes', async () => {
  const value = await fixture(), protectedPath = path.join(value.root, 'existing.bin');
  await fs.writeFile(protectedPath, 'keep');
  await assert.rejects(encryptFile(value.input, protectedPath, key, context));
  await assert.rejects(decryptFile(value.encrypted, protectedPath, key, context));
  assert.equal(await fs.readFile(protectedPath, 'utf8'), 'keep');
});
