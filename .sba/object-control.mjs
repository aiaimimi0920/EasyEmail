// Application-owned, secret-authenticated R2 backup/restore transport; no public mailbox permissions bypass.
import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

const prefix = '/__easyemail_sba/v1/', limit = 268435456;
const httpFields = new Set(['contentType', 'contentEncoding', 'contentLanguage', 'contentDisposition', 'cacheControl', 'cacheExpiry']);
const json = (value, status = 200) => new Response(JSON.stringify(value), { status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
const invalid = () => { throw new Error('invalid'); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function authenticated(request, env) {
  const key = env.EASYEMAIL_SBA_CONTROL_SECRET, value = request.headers.get('authorization');
  return typeof key === 'string' && /^[a-f0-9]{64}$/.test(key) && /^Bearer [a-f0-9]{64}$/.test(value ?? '')
    && timingSafeEqual(Buffer.from(key, 'ascii'), Buffer.from(value.slice(7), 'ascii'));
}

function metadata(object) {
  return { key: object.key, size: object.size, etag: object.etag, version: object.version,
    uploaded: object.uploaded.toISOString(), httpMetadata: object.httpMetadata ?? {},
    customMetadata: object.customMetadata ?? {}, storageClass: object.storageClass ?? 'Standard' };
}

function restoreMetadata(request) {
  const header = request.headers.get('x-easyemail-r2-metadata');
  if (!header || header.length > 16384 || !/^[A-Za-z0-9+/]*={0,2}$/.test(header)) invalid();
  const bytes = Buffer.from(header, 'base64');
  if (bytes.toString('base64') !== header) invalid();
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!record(value) || Object.keys(value).some(key => !['size', 'sha256', 'httpMetadata', 'customMetadata', 'storageClass'].includes(key))
    || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > limit || !/^[a-f0-9]{64}$/.test(value.sha256 ?? '')
    || !record(value.httpMetadata) || !record(value.customMetadata) || !['Standard', 'InfrequentAccess'].includes(value.storageClass ?? 'Standard')) invalid();
  if (Object.entries(value.httpMetadata).some(([key, item]) => !httpFields.has(key) || typeof item !== 'string' || /[\x00-\x1f\x7f]/.test(item))) invalid();
  if (Object.entries(value.customMetadata).some(([key, item]) => !key || typeof item !== 'string')
    || Buffer.byteLength(JSON.stringify(value.customMetadata)) > 2048) invalid();
  if (value.httpMetadata.cacheExpiry !== undefined) {
    const date = new Date(value.httpMetadata.cacheExpiry);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== value.httpMetadata.cacheExpiry) invalid();
    value.httpMetadata.cacheExpiry = date;
  }
  if (request.headers.get('content-type') !== 'application/octet-stream' || request.headers.has('content-encoding')
    || request.headers.get('content-length') !== String(value.size) || (!request.body && value.size !== 0)) invalid();
  return value;
}

export async function objectControl(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(prefix)) return undefined;
  if (!authenticated(request, env)) return json({ error: 'not_found' }, 404);
  let bucket, key, input;
  const operation = url.pathname.slice(prefix.length), query = url.searchParams;
  try {
    if (!['objects', 'object'].includes(operation)) invalid();
    const allowed = operation === 'objects' ? ['bucket', 'cursor'] : ['bucket', 'key'];
    if ([...query.keys()].some(name => !allowed.includes(name) || query.getAll(name).length !== 1)) invalid();
    const binding = query.get('bucket');
    if (!['INBOX', 'OUTBOX'].includes(binding) || !env[binding]) invalid();
    bucket = env[binding]; key = query.get('key');
    if (operation === 'object' && (typeof key !== 'string' || !key || Buffer.byteLength(key) > 1024)) invalid();
    const cursor = query.get('cursor');
    if (cursor !== null && (!cursor || cursor.length > 4096 || /[\x00-\x1f\x7f]/.test(cursor))) invalid();
    if (!['GET', 'PUT'].includes(request.method) || operation === 'objects' && request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    if (request.method === 'PUT') input = restoreMetadata(request);
  } catch { return json({ error: 'invalid_control_request' }, 400); }
  try {
    if (operation === 'objects') {
      const result = await bucket.list({ limit: 50, ...(query.has('cursor') ? { cursor: query.get('cursor') } : {}), include: ['httpMetadata', 'customMetadata'] });
      return json({ objects: result.objects.map(metadata), truncated: result.truncated, cursor: result.truncated ? result.cursor : null });
    }
    if (request.method === 'GET') {
      const result = await bucket.get(key);
      if (!result) return json({ error: 'object_absent' }, 404);
      return new Response(result.body, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(result.size),
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'x-easyemail-r2-metadata': Buffer.from(JSON.stringify(metadata(result))).toString('base64') } });
    }
    const result = await bucket.put(key, request.body ?? new Uint8Array(), { sha256: input.sha256,
      httpMetadata: input.httpMetadata, customMetadata: input.customMetadata, storageClass: input.storageClass ?? 'Standard',
      onlyIf: new Headers({ 'if-none-match': '*' }) });
    if (!result) return json({ error: 'object_already_exists' }, 409);
    if (result.size !== input.size) throw new Error('length mismatch');
    return json(metadata(result), 201);
  } catch { return json({ error: 'object_control_unconfirmed' }, 503); }
}
