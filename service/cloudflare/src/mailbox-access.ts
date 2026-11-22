import { HttpError } from "./http";
import { mailboxExpired, type MailboxExpiry } from "./mailbox-expiry";

export function assertMailboxUsable(mailbox: MailboxExpiry & { status: string; disabled_at: number | null; released_at: number | null }): void {
  if (mailbox.released_at !== null) throw new HttpError(409, "mailbox_released");
  if (mailboxExpired(mailbox)) throw new HttpError(409, "mailbox_expired");
  if (mailbox.disabled_at !== null) throw new HttpError(409, "mailbox_disabled");
  if (mailbox.status !== "active") throw new HttpError(409, "mailbox_not_active");
}
