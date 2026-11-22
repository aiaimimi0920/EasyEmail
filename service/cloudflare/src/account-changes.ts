import { unixNow, type Env, type Identity } from './contracts';
import { ADMIN_EXISTS } from './admin-access';
import { HttpError } from './http';
import { ACTIVE_SESSION_FENCE, assertActiveSession } from './session-security';

interface AccountChange {
  userId: string; expectedRevision: number; action: 'disable' | 'enable' | 'revoke-credentials' | 'password-change';
  status?: 'active' | 'disabled'; previousPasswordHash?: string; passwordHash?: string;
}

export async function changeAccount(env: Env, identity: Identity, change: AccountChange): Promise<void> {
  const id = crypto.randomUUID(), now = unixNow(), revision = change.expectedRevision + 1;
  const admin = change.action !== 'password-change';
  const targetFence = admin ? ADMIN_EXISTS : 'EXISTS (SELECT 1 FROM users WHERE id=? AND status=\'active\' AND password_hash=?)';
  const targetValues = admin ? [identity.userId] : [identity.userId, change.previousPasswordHash!];
  const reservation = env.DB.prepare(`INSERT INTO account_audit(id,actor_id,user_id,action,revision,created_at)
    SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM users WHERE id=?)
    AND COALESCE((SELECT revision FROM account_revisions WHERE user_id=?),0)=?
    AND ${ACTIVE_SESSION_FENCE} AND ${targetFence}`)
    .bind(id, identity.userId, change.userId, change.action, revision, now, change.userId, change.userId, change.expectedRevision,
      identity.credentialId, identity.userId, ...targetValues);
  const applied = 'EXISTS (SELECT 1 FROM account_audit WHERE id=?)';
  const mutation = change.passwordHash ? env.DB.prepare(`UPDATE users SET password_hash=? WHERE id=? AND ${applied}`)
    .bind(change.passwordHash, change.userId, id) : change.status ? env.DB.prepare(`UPDATE users SET status=? WHERE id=? AND ${applied}`)
      .bind(change.status, change.userId, id) : null;
  const results = await env.DB.batch([reservation, ...(mutation ? [mutation] : []),
    env.DB.prepare(`UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL AND ${applied}`).bind(now, change.userId, id),
    env.DB.prepare(`UPDATE api_keys SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL AND ${applied}`).bind(now, change.userId, id),
    env.DB.prepare(`INSERT INTO account_revisions(user_id,revision,updated_at) SELECT ?,?,? WHERE ${applied}
      ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at`).bind(change.userId, revision, now, id),
  ]);
  if (results[0].meta.changes) return;
  await assertActiveSession(env, identity);
  if (admin && !await env.DB.prepare(`SELECT 1 WHERE ${ADMIN_EXISTS}`).bind(identity.userId).first()) throw new HttpError(403, 'administrator_required');
  throw new HttpError(409, 'account_state_changed');
}
