import { HttpError } from "./http";
import { openImapMailbox } from "./normal-imap-protocol";
import { ImapWire, type ImapSocket } from "./normal-imap-wire";
import { fetchImapMessage, IMAP_MESSAGE_BYTES } from "./normal-imap-fetch";
import { imapNumber } from "./normal-imap-fetch-input";
import type { MailSocketControl } from "./mail-socket-session";
import type { MailAuthentication } from "./mail-authentication";
import { imapFolderName } from "./normal-imap-folder-names";

export interface ImapCursor { uidValidity: string; afterUid: number }
export interface ImapMessage { uid: number; raw: Uint8Array; receivedAt: number; flags: string[] }
export function assertImapCursor(cursor: ImapCursor | null) {
  if (cursor === null) return;
  if (!cursor || typeof cursor !== "object" || Object.keys(cursor).some(key => !["uidValidity", "afterUid"].includes(key))
    || typeof cursor.uidValidity !== "string" || !/^[1-9]\d{0,9}$/.test(cursor.uidValidity) || Number(cursor.uidValidity) > 4294967295
    || !Number.isSafeInteger(cursor.afterUid) || cursor.afterUid < 0 || cursor.afterUid > 4294967295) throw new HttpError(400, "invalid_imap_cursor");
}
export async function readImapBatch(socket: ImapSocket, username: string, authentication: MailAuthentication, cursor: ImapCursor | null = null, control?: MailSocketControl, mailbox = "INBOX") {
  assertImapCursor(cursor); imapFolderName(mailbox);
  const wire = new ImapWire(socket, 7 * 1024 * 1024, control);
  try {
    const selected = await openImapMailbox(wire, username, authentication, mailbox), validity = selected.inbox.uidValidity;
    const nextRows = selected.responses.filter(line => /^\* (?:OK|NO|BAD) \[UIDNEXT(?: |\])/i.test(line));
    const next = /^\* OK \[UIDNEXT ([1-9]\d{0,9})\](?: |$)/i.exec(nextRows[0] ?? "")?.[1];
    if (nextRows.length !== 1 || !next || Number(next) > 4294967295) throw new HttpError(502, "imap_uid_next_missing");
    if (selected.responses.some(line => /\[UIDNOTSTICKY\]/i.test(line))) throw new HttpError(409, "imap_uids_not_sticky");
    const reset = cursor !== null && cursor.uidValidity !== validity, after = cursor && !reset ? cursor.afterUid : 0, upper = Number(next) - 1;
    if (after > upper) throw new HttpError(409, "imap_uid_checkpoint_invalid");
    const end = Math.min(upper, after + 100), items: ImapMessage[] = [], skipped: { uid: number; reason: string }[] = [];
    let checkpoint = after;
    if (after < end) {
      const rows = (await wire.command(`UID SEARCH UID ${after + 1}:${end}`)).filter(line => /^\* SEARCH(?: |$)/i.test(line));
      if (rows.length !== 1) throw new HttpError(502, "imap_protocol_invalid");
      const raw = rows[0].slice(8).trim(), uids = raw ? raw.split(" ").map(value => imapNumber(value)) : [];
      if (uids.length > 100 || new Set(uids).size !== uids.length || uids.some(uid => uid <= after || uid > end)) throw new HttpError(502, "imap_protocol_invalid");
      uids.sort((a, b) => a - b);
      for (const uid of uids.slice(0, 3)) {
        const metadata = await fetchImapMessage(wire, uid);
        if (!metadata) skipped.push({ uid, reason: "message_missing" });
        else if (metadata.size > IMAP_MESSAGE_BYTES) skipped.push({ uid, reason: "message_too_large" });
        else {
          const message = await fetchImapMessage(wire, uid, metadata);
          if (!message) skipped.push({ uid, reason: "message_missing" });
          else items.push({ uid, raw: message.raw!, receivedAt: message.receivedAt, flags: message.flags });
        }
        checkpoint = uid;
      }
      if (uids.length <= 3) checkpoint = end;
    }
    await wire.write("eeLogout LOGOUT");
    return { inbox: selected.inbox, uidNext: Number(next), cursor: { uidValidity: validity, afterUid: checkpoint }, reset,
      complete: checkpoint === upper, items, skipped };
  } finally { wire.release(); }
}
