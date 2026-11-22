import type { Env } from './contracts';
import { HttpError, json, pageOptions } from './http';

export interface AccountRow {
  id: string; username: string; status: 'active' | 'disabled'; createdAt: number;
  revision: number; updatedAt: number | null; isAdmin: number;
  activeSessions: number; activeKeys: number; mailboxes: number;
}
const COLUMNS = `u.id,u.username,u.status,u.created_at AS createdAt,COALESCE(r.revision,0) AS revision,r.updated_at AS updatedAt,
  EXISTS(SELECT 1 FROM platform_admins WHERE user_id=u.id) AS isAdmin,
  (SELECT COUNT(*) FROM sessions WHERE user_id=u.id AND revoked_at IS NULL AND expires_at>unixepoch()) AS activeSessions,
  (SELECT COUNT(*) FROM api_keys WHERE user_id=u.id AND revoked_at IS NULL AND expires_at>unixepoch()) AS activeKeys,
  (SELECT COUNT(*) FROM mailboxes WHERE user_id=u.id) AS mailboxes`;
const SOURCE = 'FROM users u LEFT JOIN account_revisions r ON r.user_id=u.id';
export const accountView = (row: AccountRow) => ({ ...row, isAdmin: !!row.isAdmin });

export async function accountRow(env: Env, id: string): Promise<AccountRow> {
  const row = await env.DB.prepare(`SELECT ${COLUMNS} ${SOURCE} WHERE u.id=?`).bind(id).first<AccountRow>();
  if (!row) throw new HttpError(404, 'not_found'); return row;
}

export async function listAccounts(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url), { limit, cursor } = pageOptions(url);
  if ([...url.searchParams.keys()].some((key) => !['limit', 'cursor', 'q', 'status'].includes(key))) throw new HttpError(400, 'invalid_account_filter');
  const query = (url.searchParams.get('q') ?? '').trim().toLowerCase(), status = url.searchParams.get('status') ?? '';
  if (query.length > 64 || status && !['active', 'disabled'].includes(status)) throw new HttpError(400, 'invalid_account_filter');
  const { results } = await env.DB.prepare(`SELECT ${COLUMNS} ${SOURCE}
    WHERE u.id>? AND instr(lower(u.username),?)>0 AND (?='' OR u.status=?) ORDER BY u.id LIMIT ?`)
    .bind(cursor, query, status, status, limit + 1).all<AccountRow>();
  const items = results.slice(0, limit).map(accountView);
  return json({ items, nextCursor: results.length > limit ? items.at(-1)!.id : null });
}

export async function listAccountAudit(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url), { limit, cursor } = pageOptions(url), user = url.searchParams.get('userId') ?? '';
  if ([...url.searchParams.keys()].some((key) => !['limit', 'cursor', 'userId'].includes(key))
    || user && !/^[0-9a-f-]{36}$/.test(user)) throw new HttpError(400, 'invalid_account_filter');
  const { results } = await env.DB.prepare(`SELECT id,actor_id AS actorId,user_id AS userId,action,revision,created_at AS createdAt
    FROM account_audit WHERE id>? AND (?='' OR user_id=?) ORDER BY id LIMIT ?`).bind(cursor, user, user, limit + 1).all<{ id: string }>();
  const items = results.slice(0, limit); return json({ items, nextCursor: results.length > limit ? items.at(-1)!.id : null });
}
