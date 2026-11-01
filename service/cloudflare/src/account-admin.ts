import type { Env, Identity } from './contracts';
import { HttpError, json, readJson } from './http';
import { accountRow, accountView, listAccountAudit, listAccounts } from './account-store';
import { changeAccount } from './account-changes';
import { sessionCookie } from './auth';
import { assertActiveSession } from './session-security';

export function isAccountAdminPath(path: string): boolean {
  return /^\/api\/v1\/admin\/users(?:\/audit|\/[0-9a-f-]{36}(?:\/(?:status|revoke-credentials))?)?$/.test(path);
}

export async function accountAdmin(request: Request, env: Env, identity: Identity): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method === 'GET' && path.endsWith('/users')) return listAccounts(request, env);
  if (request.method === 'GET' && path.endsWith('/users/audit')) return listAccountAudit(request, env);
  const match = /^\/api\/v1\/admin\/users\/([0-9a-f-]{36})(?:\/(status|revoke-credentials))?$/.exec(path);
  if (!match) throw new HttpError(405, 'method_not_allowed');
  if (!match[2] && request.method === 'GET') return json({ user: accountView(await accountRow(env, match[1])) });
  if (request.method !== 'POST' || !match[2]) throw new HttpError(405, 'method_not_allowed');
  const body = await readJson(request), row = await accountRow(env, match[1]);
  const fields = match[2] === 'status' ? ['status', 'expectedRevision', 'confirmUsername'] : ['expectedRevision', 'confirmUsername'];
  if (Object.keys(body).some((key) => !fields.includes(key)) || !Number.isSafeInteger(body.expectedRevision)
    || (body.expectedRevision as number) < 0 || (body.expectedRevision as number) >= Number.MAX_SAFE_INTEGER
    || match[2] === 'status' && !['active', 'disabled'].includes(body.status as string)) throw new HttpError(400, 'invalid_account_request');
  if (body.confirmUsername !== row.username) throw new HttpError(400, 'account_confirmation_required');
  if (body.status === 'disabled' && row.id === identity.userId) throw new HttpError(403, 'self_account_disable_denied');
  if (body.expectedRevision !== row.revision) throw new HttpError(409, 'account_state_changed');
  if (match[2] === 'status' && row.status === body.status) {
    await assertActiveSession(env, identity); return json({ user: accountView(row), changed: false });
  }
  const action = match[2] === 'status' ? body.status === 'disabled' ? 'disable' : 'enable' : 'revoke-credentials';
  await changeAccount(env, identity, { userId: row.id, expectedRevision: row.revision, action,
    ...(match[2] === 'status' ? { status: body.status as 'active' | 'disabled' } : {}) });
  const reauthenticate = row.id === identity.userId;
  return json({ user: accountView(await accountRow(env, row.id)), changed: true, reauthenticate }, 200,
    reauthenticate ? { 'set-cookie': sessionCookie('', 0) } : undefined);
}
