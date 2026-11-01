import { HttpError } from "./http";
import { ImapWire, type ImapSocket } from "./normal-imap-wire";
import { openAuthenticatedImap } from "./normal-imap-protocol";
import type { MailSocketControl } from "./mail-socket-session";
import type { MailAuthentication } from "./mail-authentication";
import { imapFolderName } from "./normal-imap-folder-names";

export interface ImapFlagCommand { uid: number; uidValidity: string; flag: "\\Seen" | "\\Flagged"; value: boolean }
export function assertImapFlagCommand(command: ImapFlagCommand) {
  if (!command || Object.keys(command).some(key => !["uid", "uidValidity", "flag", "value"].includes(key))
    || !Number.isSafeInteger(command.uid) || command.uid < 1 || command.uid > 4294967295
    || typeof command.uidValidity !== "string" || !/^[1-9]\d{0,9}$/.test(command.uidValidity) || Number(command.uidValidity) > 4294967295
    || !["\\Seen", "\\Flagged"].includes(command.flag) || typeof command.value !== "boolean") throw new HttpError(400, "invalid_remote_flags_request");
}
function selectedMailbox(lines: string[], completion: string, command: ImapFlagCommand) {
  if (!/^\S+ OK \[READ-WRITE\](?: |$)/i.test(completion)) throw new HttpError(409, "imap_flags_read_only");
  const identities = lines.filter(line => /^\* (?:OK|NO|BAD) \[UIDVALIDITY(?: |\])/i.test(line));
  const actual = /^\* OK \[UIDVALIDITY ([1-9]\d{0,9})\](?: |$)/i.exec(identities[0] ?? "")?.[1];
  if (identities.length !== 1 || actual !== command.uidValidity) throw new HttpError(409, "imap_flags_epoch_changed");
  if (lines.some(line => /\[UIDNOTSTICKY\]/i.test(line))) throw new HttpError(502, "imap_uids_not_sticky");
  const permanent = lines.filter(line => /^\* (?:OK|NO|BAD) \[PERMANENTFLAGS(?: |\])/i.test(line));
  const allowed = /^\* OK \[PERMANENTFLAGS \(([^()]*)\)\](?: |$)/i.exec(permanent[0] ?? "")?.[1].split(/ +/);
  if (permanent.length !== 1 || !allowed?.some(flag => flag.toLowerCase() === command.flag.toLowerCase())) throw new HttpError(409, "imap_flags_not_permanent");
}
function parseFlags(value: string) {
  const flags = value ? value.split(" ") : [];
  if (flags.length > 100 || flags.some(flag => !/^(?:\\)?[^\x00-\x20\x7f-\uffff(){%*"\\\]]{1,80}$/.test(flag))
    || new Set(flags.map(flag => flag.toLowerCase())).size !== flags.length) throw new HttpError(502, "imap_protocol_invalid");
  return flags;
}
export function readFlags(wire: ImapWire, uid: number): Promise<string[]>;
export function readFlags(wire: ImapWire, uid: number, allowMissing: true): Promise<string[] | null>;
export async function readFlags(wire: ImapWire, uid: number, allowMissing = false) {
  const lines = await wire.command(`UID FETCH ${uid} (UID FLAGS)`);
  let found: string[] | undefined;
  for (const line of lines) {
    if (!/^\* [1-9]\d* FETCH /i.test(line)) {
      if (!/^\* (?:OK|NO|BAD|\d+ (?:EXISTS|RECENT|EXPUNGE))(?: |$)/i.test(line)) throw new HttpError(502, "imap_protocol_invalid");
      continue;
    }
    const match = /^\* [1-9]\d* FETCH \((?:UID ([1-9]\d{0,9}) FLAGS \(([^()]*)\)|FLAGS \(([^()]*)\) UID ([1-9]\d{0,9}))\)$/i.exec(line);
    if (!match) {
      const notification = /^\* [1-9]\d* FETCH \(FLAGS \(([^()]*)\)\)$/i.exec(line);
      if (!notification) throw new HttpError(502, "imap_protocol_invalid");
      parseFlags(notification[1]); continue;
    }
    const flags = parseFlags(match[2] ?? match[3]), actualUid = Number(match[1] ?? match[4]);
    if (actualUid > 4294967295) throw new HttpError(502, "imap_protocol_invalid");
    if (actualUid !== uid) continue;
    if (found) throw new HttpError(502, "imap_protocol_invalid");
    found = flags;
  }
  if (!found) { if (allowMissing) return null; throw new HttpError(409, "imap_flags_message_missing"); }
  return found;
}
// No implicit read marking: one explicit flag and stable mailbox UID, no automatic reconnect/retry.
export async function changeImapFlags(socket: ImapSocket, username: string, authentication: MailAuthentication,
  command: ImapFlagCommand, beforeDispatch: () => Promise<void>, control?: MailSocketControl, mailbox = "INBOX") {
  assertImapFlagCommand(command);
  const name = imapFolderName(mailbox).wireName, argument = name === "INBOX" ? "INBOX" : `"${name.replace(/["\\]/g, "\\$&")}"`;
  const wire = new ImapWire(socket, 65536, control);
  try {
    await openAuthenticatedImap(wire, username, authentication);
    selectedMailbox(await wire.command(`SELECT ${argument}`), wire.completion, command);
    await readFlags(wire, command.uid);
    control?.assertActive(); await beforeDispatch(); control?.assertActive();
    await wire.command(`UID STORE ${command.uid} ${command.value ? "+" : "-"}FLAGS.SILENT (${command.flag})`);
    const flags = await readFlags(wire, command.uid);
    if (flags.some(flag => flag.toLowerCase() === command.flag.toLowerCase()) !== command.value) throw new HttpError(502, "imap_flags_unconfirmed");
    // A failed LOGOUT cannot undo a confirmed STORE/readback. Socket lifetime belongs to withMailSocket.
    return { flags };
  } finally { wire.release(); }
}
