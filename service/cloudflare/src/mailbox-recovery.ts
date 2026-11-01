import { unixNow, type Env, type Identity } from './contracts';
import { HttpError, readJson } from './http';
import { requireScope, requireWriteScope } from './identity';
import { mailAddress } from './mail-address';
import { configuredProvider, connectProvider } from './providers/registry';
import { assertVault, credentialRequestHash, encryptCredential } from './mailbox-vault';
import { mailboxExpired } from './mailbox-expiry';
import type { OwnedMailbox } from './mailbox-sync';
import { readRetention } from './retention-policy';
import { rateLimit } from './rate-limits';
import { assertMailboxQuiescent } from './mailbox-delete-store';
import { assertRecoverySchema, recoveryByKey, recoveryResponse, storeRecovery, type AccessRecovery } from './mailbox-recovery-store';

function recoveryInput(body: Record<string, unknown>) {
  const address = mailAddress(body.address)?.toLowerCase();
  if (Object.keys(body).length !== 3 || Object.keys(body).some(key => !['providerId', 'address', 'token'].includes(key))
    || typeof body.providerId !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(body.providerId) || !address
    || typeof body.token !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(body.token)
    || body.token.length > 4096) throw new HttpError(400, 'invalid_mailbox_recovery_request');
  return { providerId: body.providerId, address, token: body.token };
}

export async function mailboxRecovery(request: Request, env: Env, identity: Identity, key?: string): Promise<Response> {
  if (request.method === 'GET' && key) {
    requireScope(identity, 'mailboxes:read');
    await assertRecoverySchema(env);
    const row = await recoveryByKey(env, identity, key);
    if (!row) throw new HttpError(404, 'mailbox_recovery_not_found');
    return recoveryResponse(row);
  }
  if (request.method !== 'POST' || key) throw new HttpError(405, 'method_not_allowed');
  requireWriteScope(request, env, identity, 'mailboxes:write');
  const input = recoveryInput(await readJson(request));
  key = request.headers.get('idempotency-key') ?? '';
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(key)) throw new HttpError(400, 'idempotency_key_required');
  await assertRecoverySchema(env); assertVault(env);
  const previousReceipt = await recoveryByKey(env, identity, key);
  const hash = await credentialRequestHash(env, { id: key, user_id: identity.userId, provider_id: input.providerId,
    purpose: 'mailbox-access-recovery-v1' }, JSON.stringify(input), previousReceipt?.request_hash);
  if (previousReceipt) {
    if (previousReceipt.request_hash !== hash) throw new HttpError(409, 'idempotency_conflict');
    return recoveryResponse(previousReceipt);
  }
  await rateLimit(env, 'mailbox-access-recovery', identity.userId, 5);
  const config = await configuredProvider(env, input.providerId);
  if (config.type !== 'cloudflare' || config.domains.length && !config.domains.includes(input.address.split('@')[1])) {
    throw new HttpError(409, 'mailbox_recovery_unavailable');
  }
  const provider = await connectProvider(env, config);
  if (!provider.recoverAccess) throw new HttpError(409, 'mailbox_recovery_unavailable');
  const previous = await env.DB.prepare('SELECT * FROM mailboxes WHERE address=? COLLATE NOCASE').bind(input.address).first<OwnedMailbox>();
  if (previous && (previous.user_id !== identity.userId || previous.provider_id !== config.id)) throw new HttpError(409, 'mailbox_address_unavailable');
  if (previous && mailboxExpired(previous)) throw new HttpError(409, 'mailbox_expired');
  if (previous) {
    if (previous.status !== 'active') throw new HttpError(409, 'mailbox_not_active');
    if (await env.DB.prepare('SELECT 1 FROM remote_mailbox_deletions WHERE mailbox_id=?').bind(previous.id).first()) {
      throw new HttpError(409, 'remote_mailbox_delete_in_progress');
    }
    await assertMailboxQuiescent(env, previous.id);
  }
  const remote = await provider.recoverAccess(input.address, input.token);
  if (previous && previous.remote_id !== remote.remoteId) throw new HttpError(409, 'mailbox_address_unavailable');
  const retention = await readRetention(env), now = unixNow();
  const policyExpiry = retention.policy.enabled && retention.policy.mailboxDays > 0 ? now + retention.policy.mailboxDays * 86400 : null;
  const limit = Math.min(policyExpiry ?? Infinity, remote.expiresAt ?? Infinity);
  const expiresAt = previous ? previous.expires_at : Number.isFinite(limit) ? limit : null;
  const row: AccessRecovery = { id: crypto.randomUUID(), user_id: identity.userId, request_key: key, request_hash: hash,
    mailbox_id: previous?.id ?? crypto.randomUUID(), provider_id: config.id, address: input.address,
    mode: previous ? previous.released_at !== null ? 'restored' : 'refreshed' : 'imported', created_at: now };
  const cipher = await encryptCredential(env, { id: row.mailbox_id, user_id: row.user_id, provider_id: row.provider_id }, remote.credential);
  let saved = false;
  try { saved = await storeRecovery(env, identity, config, row, previous, remote.remoteId, cipher, expiresAt, remote.expiresAt ?? null, retention.revision); }
  catch {
    // This operation only reads upstream. Reconcile the original key; never claim an uncommitted credential.
    const winner = await recoveryByKey(env, identity, key);
    if (winner) {
      if (winner.request_hash !== hash) throw new HttpError(409, 'idempotency_conflict');
      return recoveryResponse(winner);
    }
    throw new HttpError(503, 'mailbox_recovery_storage_unconfirmed');
  }
  if (saved) return recoveryResponse(row, previous ? 200 : 201);
  const winner = await recoveryByKey(env, identity, key);
  if (winner) {
    if (winner.request_hash !== hash) throw new HttpError(409, 'idempotency_conflict');
    return recoveryResponse(winner);
  }
  throw new HttpError(409, 'mailbox_recovery_changed_or_limit');
}
