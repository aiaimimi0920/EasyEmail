import { unixNow } from "./contracts";

export interface MailboxExpiry { expires_at: number | null; expired_at: number | null }
export const MAILBOX_EXPIRY_FENCE = "expired_at IS NULL AND (expires_at IS NULL OR expires_at > unixepoch())";

export function mailboxExpired(row: MailboxExpiry): boolean {
  return row.expired_at !== null || (row.expires_at !== null && row.expires_at <= unixNow());
}
