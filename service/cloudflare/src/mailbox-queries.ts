import type { Env, Identity } from "./contracts";
import { HttpError, json, pageOptions } from "./http";
import { requireScope } from "./identity";
import { unixNow } from "./contracts";

const COLUMNS = `id, provider_id AS providerId, address, status, created_at AS createdAt,
  synced_at AS syncedAt, sync_error AS syncError, next_page AS nextPage,
  display_name AS displayName, note, favorite, paused, disabled_at AS disabledAt, released_at AS releasedAt,
  expires_at AS expiresAt, expired_at AS expiredAt`;

function mailboxView(row: Record<string, unknown>) {
  return { ...row, favorite: row.favorite === 1, paused: row.paused === 1, disabled: row.disabledAt !== null,
    expired: row.expiredAt !== null || (row.expiresAt !== null && (row.expiresAt as number) <= unixNow()) };
}

export async function listMailboxes(request: Request, env: Env, identity: Identity): Promise<Response> {
  requireScope(identity, "mailboxes:read");
  const { limit, cursor } = pageOptions(new URL(request.url));
  const { results } = await env.DB.prepare(`SELECT ${COLUMNS} FROM mailboxes
    WHERE user_id = ? AND id > ? ORDER BY id LIMIT ?`).bind(identity.userId, cursor, limit + 1).all<{ id: string } & Record<string, unknown>>();
  const items = results.slice(0, limit);
  return json({ items: items.map(mailboxView), nextCursor: results.length > limit ? items.at(-1)!.id : null });
}

export async function getMailbox(env: Env, identity: Identity, id: string): Promise<Response> {
  requireScope(identity, "mailboxes:read");
  const mailbox = await env.DB.prepare(`SELECT ${COLUMNS} FROM mailboxes WHERE id = ? AND user_id = ?`)
    .bind(id, identity.userId).first();
  if (!mailbox) throw new HttpError(404, "not_found");
  return json({ mailbox: mailboxView(mailbox) });
}
