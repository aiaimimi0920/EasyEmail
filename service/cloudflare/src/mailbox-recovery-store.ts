import type { Env, Identity } from './contracts';
import { unixNow } from './contracts';
import { HttpError, json } from './http';
import { identityCredentialFence } from './identity';
import type { OwnedMailbox } from './mailbox-sync';
import type { ProviderConfig } from './providers/contracts';
import { PROVIDER_REVISION_FENCE } from './providers/settings';
import { MAILBOX_EXPIRY_FENCE } from './mailbox-expiry';
import { MAILBOX_QUOTAS } from './quota-policy';
import { RETENTION_POLICY_FENCE } from './retention-policy';

export interface AccessRecovery {
  id: string; user_id: string; request_key: string; request_hash: string; mailbox_id: string;
  provider_id: string; address: string; mode: 'imported' | 'restored' | 'refreshed'; created_at: number;
}
export async function assertRecoverySchema(env: Env): Promise<void> {
  if (!await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mailbox_access_recoveries'").first()) {
    throw new HttpError(503, 'mailbox_recovery_schema_required');
  }
}
export function recoveryByKey(env: Env, identity: Identity, key: string) {
  return env.DB.prepare('SELECT * FROM mailbox_access_recoveries WHERE user_id=? AND request_key=?')
    .bind(identity.userId, key).first<AccessRecovery>();
}
export function recoveryResponse(row: AccessRecovery, status = 200): Response {
  return json({ recovery: { requestKey: row.request_key, mailboxId: row.mailbox_id, providerId: row.provider_id,
    address: row.address, mode: row.mode, createdAt: row.created_at } }, status);
}
export const RECOVERY_QUIESCENT = `NOT EXISTS(SELECT 1 FROM outgoing_messages WHERE mailbox_id=mailboxes.id AND state IN ('pending','unknown'))
  AND NOT EXISTS(SELECT 1 FROM remote_deletions WHERE mailbox_id=mailboxes.id AND state IN ('pending','unknown'))
  AND NOT EXISTS(SELECT 1 FROM send_jobs WHERE mailbox_id=mailboxes.id AND state IN ('queued','preparing'))`;

export async function storeRecovery(env: Env, identity: Identity, config: ProviderConfig, row: AccessRecovery,
  previous: OwnedMailbox | null, remoteId: string, cipher: string, expiresAt: number | null, proofExpiresAt: number | null, policyRevision: number): Promise<boolean> {
  const caller = `${identityCredentialFence(identity)}${identity.kind === 'apiKey'
    ? " AND EXISTS(SELECT 1 FROM api_keys k,json_each(k.scopes) j WHERE k.id=? AND j.value='mailboxes:write')" : ''}`;
  const callerValues = [identity.credentialId, identity.userId, ...(identity.kind === 'apiKey' ? [identity.credentialId] : [])];
  const current = previous ? `EXISTS(SELECT 1 FROM mailboxes WHERE id=? AND user_id=? AND provider_id=? AND remote_id=? AND address=?
    AND sync_revision=? AND credential_cipher IS ? AND disabled_at IS ? AND released_at IS ? AND expires_at IS ? AND expired_at IS ?
    AND status='active' AND ${MAILBOX_EXPIRY_FENCE} AND ${RECOVERY_QUIESCENT}
    AND NOT EXISTS(SELECT 1 FROM remote_mailbox_deletions WHERE mailbox_id=mailboxes.id))`
    : `NOT EXISTS(SELECT 1 FROM mailboxes WHERE address=? COLLATE NOCASE OR (provider_id=? AND remote_id=?))
      AND NOT EXISTS(SELECT 1 FROM mailbox_creations WHERE address=? COLLATE NOCASE)
      AND (SELECT COUNT(*) FROM mailbox_creations WHERE user_id=?) < ${MAILBOX_QUOTAS.allocationsPerUser}
      AND (SELECT COUNT(*) FROM mailboxes WHERE user_id=?) < ${MAILBOX_QUOTAS.allocationsPerUser}`;
  const currentValues = previous ? [previous.id, identity.userId, config.id, remoteId, row.address, previous.sync_revision,
    previous.credential_cipher, previous.disabled_at, previous.released_at, previous.expires_at, previous.expired_at]
    : [row.address, config.id, remoteId, row.address, identity.userId, identity.userId];
  const statements = [env.DB.prepare(`INSERT INTO mailbox_access_recoveries
    (id,user_id,request_key,request_hash,mailbox_id,provider_id,address,mode,created_at)
    SELECT ?,?,?,?,?,?,?,?,? WHERE ${caller} AND ${PROVIDER_REVISION_FENCE} AND ${RETENTION_POLICY_FENCE} AND ${current}
      AND (SELECT COUNT(*) FROM mailbox_access_recoveries WHERE user_id=?) < 1000
      AND (? IS NULL OR ?>unixepoch()) AND (? IS NULL OR ?>unixepoch()) ON CONFLICT(user_id,request_key) DO NOTHING`)
    .bind(row.id, row.user_id, row.request_key, row.request_hash, row.mailbox_id, row.provider_id, row.address, row.mode, row.created_at,
      ...callerValues, config.id, config.revision, policyRevision, ...currentValues, identity.userId, expiresAt, expiresAt, proofExpiresAt, proofExpiresAt)];
  // A fresh operation ID is a batch nonce: a losing replay cannot execute any follow-on writes.
  const committed = 'EXISTS(SELECT 1 FROM mailbox_access_recoveries WHERE id=? AND user_id=? AND mailbox_id=?)';
  const nonce = [row.id, identity.userId, row.mailbox_id];
  if (previous) statements.push(env.DB.prepare(`UPDATE mailboxes SET credential_cipher=?,released_at=NULL,
    expires_at=?,sync_token=NULL,sync_lease_until=NULL,sync_revision=sync_revision+1 WHERE id=? AND user_id=? AND ${committed}`)
    .bind(cipher, expiresAt, previous.id, identity.userId, ...nonce));
  else {
    statements.push(env.DB.prepare(`INSERT INTO mailbox_creations
      (user_id,request_key,request_hash,mailbox_id,address,state,created_at,expires_at,policy_revision,provider_id,provider_revision)
      SELECT ?,?,?,?,?,'complete',?,?,?,?,? WHERE ${committed}`)
      .bind(identity.userId, `recover:${row.request_key}`, row.request_hash, row.mailbox_id, row.address, row.created_at,
        expiresAt, policyRevision, config.id, config.revision, ...nonce));
    statements.push(env.DB.prepare(`INSERT INTO mailboxes
      (id,user_id,provider_id,remote_id,address,status,created_at,credential_cipher,expires_at)
      SELECT ?,?,?,?,?,'active',?,?,? WHERE ${committed}`)
      .bind(row.mailbox_id, identity.userId, config.id, remoteId, row.address, unixNow(), cipher, expiresAt, ...nonce));
  }
  const writes = await env.DB.batch(statements);
  return writes[0].meta.changes === 1;
}
