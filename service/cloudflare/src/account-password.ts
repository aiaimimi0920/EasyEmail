import type { Env, Identity } from './contracts';
import { HttpError, json, readJson, textField } from './http';
import { requireSession } from './identity';
import { hashPassword, verifyPassword } from './security';
import { rateLimit } from './rate-limits';
import { accountRow } from './account-store';
import { changeAccount } from './account-changes';
import { sessionCookie } from './auth';

export async function changePassword(request: Request, env: Env, identity: Identity): Promise<Response> {
  requireSession(identity, request, env);
  await rateLimit(env, 'account-password', identity.userId, 5);
  const body = await readJson(request);
  if (Object.keys(body).some((key) => !['currentPassword', 'newPassword'].includes(key))) throw new HttpError(400, 'invalid_password_request');
  const current = textField(body, 'currentPassword', 1, 128), password = textField(body, 'newPassword', 15, 128);
  if ([current, password].some((value) => new TextEncoder().encode(value).length > 512)) throw new HttpError(400, 'invalid_password_request');
  const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id=? AND status=\'active\'').bind(identity.userId)
    .first<{ password_hash: string }>();
  if (!await verifyPassword(current, row?.password_hash)) throw new HttpError(403, 'current_password_invalid');
  if (current === password) throw new HttpError(400, 'password_unchanged');
  const account = await accountRow(env, identity.userId), passwordHash = await hashPassword(password);
  await changeAccount(env, identity, { userId: identity.userId, expectedRevision: account.revision, action: 'password-change',
    previousPasswordHash: row!.password_hash, passwordHash });
  return json({ success: true, reauthenticate: true }, 200, { 'set-cookie': sessionCookie('', 0) });
}
