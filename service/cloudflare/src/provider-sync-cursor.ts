import type { Env } from "./contracts";
import { HttpError } from "./http";
import type { OwnedMailbox } from "./mailbox-sync";
import type { MailPage } from "./providers/contracts";
import { MAILBOX_EXPIRY_FENCE } from "./mailbox-expiry";

export async function providerSyncCursor(env: Env, row: OwnedMailbox, page: number): Promise<string | undefined> {
  if (page === 1) return undefined;
  const stored = await env.DB.prepare("SELECT cursor FROM provider_sync_cursors WHERE mailbox_id=? AND user_id=? AND next_page=?")
    .bind(row.id, row.user_id, page).first<{ cursor: string | null }>();
  if (!stored?.cursor) throw new HttpError(409, "provider_cursor_unavailable");
  return stored.cursor;
}

export function providerCursorStatement(env: Env, row: OwnedMailbox, result: MailPage, page: number, lease: string): D1PreparedStatement {
  const cursor = result.nextCursor ?? null;
  if ((result.nextPage === null) !== (cursor === null) || cursor !== null &&
    (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 2048 || result.nextPage !== page + 1 || result.nextPage > 1000)) {
    throw new HttpError(502, "provider_invalid_response");
  }
  return env.DB.prepare(`INSERT INTO provider_sync_cursors(mailbox_id,user_id,next_page,cursor)
    SELECT id,user_id,?,? FROM mailboxes WHERE id=? AND user_id=? AND status='active' AND paused=0
    AND disabled_at IS NULL AND released_at IS NULL AND sync_token=? AND sync_lease_until>unixepoch() AND ${MAILBOX_EXPIRY_FENCE}
    ON CONFLICT(mailbox_id) DO UPDATE SET next_page=excluded.next_page,cursor=excluded.cursor`)
    .bind(result.nextPage, cursor, row.id, row.user_id, lease);
}
