import type { Env, Identity } from './contracts';
import { HttpError } from './http';

export const ACTIVE_SESSION_FENCE = `EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
  WHERE s.token_hash=? AND s.user_id=? AND s.revoked_at IS NULL AND s.expires_at>unixepoch() AND u.status='active')`;

export async function assertActiveSession(env: Env, identity: Identity): Promise<void> {
  if (identity.kind !== 'session' || !await env.DB.prepare(`SELECT 1 WHERE ${ACTIVE_SESSION_FENCE}`)
    .bind(identity.credentialId, identity.userId).first()) throw new HttpError(401, 'unauthorized');
}
