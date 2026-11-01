import { HttpError } from "./http";
import { imapNumber, parseImapFetch } from "./normal-imap-fetch-input";
import type { ImapWire } from "./normal-imap-wire";

export const IMAP_MESSAGE_BYTES = 2 * 1024 * 1024;
export async function fetchImapMessage(wire: ImapWire, uid: number, expected?: { size: number; receivedAt: number }) {
  const tag = await wire.start(`UID FETCH ${uid} (UID RFC822.SIZE INTERNALDATE FLAGS${expected ? " BODY.PEEK[]" : ""})`);
  let message: Extract<ReturnType<typeof parseImapFetch>, { kind: "message" }> | null = null, sawFlagUpdate = false;
  for (let count = 0; count < 100; count++) {
    const line = await wire.line(true);
    if (line.startsWith(`${tag} `)) {
      if (!new RegExp(`^${tag} OK(?: |$)`, "i").test(line)) throw new HttpError(502, "imap_command_failed");
      // A FLAGS-only notification is not evidence that the requested message was fetched or disappeared.
      if (!message && sawFlagUpdate) throw new HttpError(502, "imap_protocol_invalid");
      return message;
    }
    if (/^\* [1-9]\d* FETCH /i.test(line)) {
      const marker = /\{(\d+)\}$/.exec(line); let raw: Uint8Array | undefined, suffix = "";
      if (marker) {
        if (!expected || !/BODY\[\] \{\d+\}$/i.test(line)) throw new HttpError(502, "imap_protocol_invalid");
        const length = imapNumber(marker[1], Number.MAX_SAFE_INTEGER, true);
        if (length > IMAP_MESSAGE_BYTES) throw new HttpError(502, "imap_response_limit");
        if (length !== expected.size) throw new HttpError(502, "imap_message_changed");
        raw = await wire.literal(length); suffix = await wire.line();
      }
      const parsed = parseImapFetch(marker ? line.slice(0, marker.index) : line, suffix, raw);
      if (parsed.kind === "flags") { sawFlagUpdate = true; continue; }
      if (message) throw new HttpError(502, "imap_protocol_invalid");
      message = parsed;
      if (message.uid !== uid || (!!expected !== (message.raw !== undefined))
        || (expected && (message.size !== expected.size || message.receivedAt !== expected.receivedAt))) throw new HttpError(502, "imap_message_changed");
    } else if (!/^\* (?:OK|NO|BAD|\d+ (?:EXISTS|RECENT|EXPUNGE))(?: |$)/i.test(line)) throw new HttpError(502, "imap_protocol_invalid");
  }
  throw new HttpError(502, "imap_response_limit");
}
