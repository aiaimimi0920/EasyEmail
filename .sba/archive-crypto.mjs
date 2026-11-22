// Versioned, context-bound authenticated encryption. Keys arrive on stdin, never command arguments.
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat, unlink } from 'node:fs/promises';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

const magic = Buffer.from('EESBA01\n'), headerSize = 52, tagSize = 16, maxSize = 268435456;
const invalid = () => { throw new Error('EASYEMAIL_ARCHIVE_CRYPTO_FAILED'); };
const hex = value => { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid(); return Buffer.from(value, 'hex'); };

async function transformFile(input, output, key, context, encrypt) {
  let target;
  try {
    const keyBytes = hex(key), identity = hex(context), size = (await stat(input)).size;
    if (!Number.isSafeInteger(size) || size < (encrypt ? 1 : headerSize + tagSize + 1)
      || size > (encrypt ? maxSize - headerSize - tagSize : maxSize)) invalid();
    let header, tag;
    if (encrypt) header = Buffer.concat([magic, randomBytes(12), identity]);
    else {
      const source = await open(input, 'r');
      try {
        header = Buffer.alloc(headerSize); tag = Buffer.alloc(tagSize);
        if ((await source.read(header, 0, headerSize, 0)).bytesRead !== headerSize
          || (await source.read(tag, 0, tagSize, size - tagSize)).bytesRead !== tagSize) invalid();
      } finally { await source.close(); }
      if (!header.subarray(0, magic.length).equals(magic) || !timingSafeEqual(header.subarray(20), identity)) invalid();
    }
    const cipher = encrypt ? createCipheriv('aes-256-gcm', keyBytes, header.subarray(8, 20))
      : createDecipheriv('aes-256-gcm', keyBytes, header.subarray(8, 20));
    cipher.setAAD(header);
    if (!encrypt) cipher.setAuthTag(tag);
    target = await open(output, 'wx', 0o600);
    if (encrypt) await target.writeFile(header);
    const expected = encrypt ? size : size - headerSize - tagSize;
    let consumed = 0;
    const bounded = new Transform({ transform(chunk, _encoding, callback) {
      consumed += chunk.length;
      callback(consumed > expected ? new Error('too_large') : null, chunk);
    } });
    let position = encrypt ? headerSize : 0;
    const stream = new Writable({ write(chunk, _encoding, callback) {
      (async () => {
        for (let offset = 0; offset < chunk.length;) {
          const { bytesWritten } = await target.write(chunk, offset, chunk.length - offset, position);
          if (!bytesWritten) invalid();
          offset += bytesWritten; position += bytesWritten;
        }
      })().then(() => callback(), callback);
    } });
    await pipeline(createReadStream(input, encrypt ? {} : { start: headerSize, end: size - tagSize - 1 }), bounded, cipher, stream);
    if (consumed !== expected) invalid();
    if (encrypt) await target.write(cipher.getAuthTag(), 0, tagSize, headerSize + size);
    await target.sync();
  } catch {
    if (target) {
      await target.close(); target = null;
      await unlink(output);
    }
    invalid();
  } finally { if (target) await target.close(); }
}

export const encryptFile = (input, output, key, context) => transformFile(input, output, key, context, true);
export const decryptFile = (input, output, key, context) => transformFile(input, output, key, context, false);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, input, output] = process.argv.slice(2);
    if (process.argv.length !== 5 || !['encrypt', 'decrypt'].includes(mode)) invalid();
    let raw = '';
    for await (const chunk of process.stdin) { raw += chunk.toString('utf8'); if (raw.length > 4096) invalid(); }
    const value = JSON.parse(raw);
    if (Object.keys(value).sort().join(',') !== 'context,key') invalid();
    await (mode === 'encrypt' ? encryptFile : decryptFile)(input, output, value.key, value.context);
  } catch { process.stderr.write('EASYEMAIL_ARCHIVE_CRYPTO_FAILED\n'); process.exitCode = 1; }
}
