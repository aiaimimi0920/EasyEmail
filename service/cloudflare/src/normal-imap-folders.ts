import { HttpError } from "./http";
import { ImapWire, type ImapSocket } from "./normal-imap-wire";
import { openAuthenticatedImap } from "./normal-imap-protocol";
import { imapFolderName, imapQuoted } from "./normal-imap-folder-names";
import type { MailAuthentication } from "./mail-authentication";
import type { MailSocketControl } from "./mail-socket-session";

export interface ImapFolder {
  wireName: string; name: string; delimiter: string | null; attributes: string[]; roles: string[]; selectable: boolean;
}
const invalid = () => new HttpError(502, "imap_protocol_invalid");
async function listFolder(wire: ImapWire, line: string): Promise<ImapFolder> {
  const match = /^\* LIST \(([^()]*)\) (NIL|"(?:[^"\\\r\n]|\\["\\])*") (.+)$/i.exec(line);
  if (!match) throw invalid();
  const attributes = match[1] ? match[1].split(" ") : [];
  if (attributes.length > 32 || attributes.some(flag => !/^\\[^\x00-\x20\x7f-\uffff(){%*"\\\]]{1,80}$/.test(flag))) throw invalid();
  const lower = attributes.map(value => value.toLowerCase()); if (new Set(lower).size !== lower.length) throw invalid();
  const delimiter = /^NIL$/i.test(match[2]) ? null : imapQuoted(match[2]);
  if (delimiter !== null && !/^[\x20-\x7e]$/.test(delimiter)) throw invalid();
  let value = match[3];
  const literal = /^\{(\d{1,4})\}$/.exec(value);
  if (literal) {
    const length = Number(literal[1]); if (length > 1024) throw new HttpError(502, "imap_folder_catalog_limit");
    const bytes = await wire.literal(length);
    if (bytes.some(byte => byte < 0x20 || byte > 0x7e) || await wire.line() !== "") throw invalid();
    value = new TextDecoder().decode(bytes);
  } else if (value.startsWith('"')) value = imapQuoted(value);
  else if (!/^[^\x00-\x20\x7f-\uffff(){%*"\\\]]+$/.test(value)) throw invalid();
  const name = imapFolderName(value), known = ["all", "archive", "drafts", "flagged", "junk", "sent", "trash"];
  return { ...name, delimiter, attributes, roles: name.wireName === "INBOX" ? ["inbox"] : known.filter(role => lower.includes(`\\${role}`)),
    selectable: !lower.includes("\\noselect") && !lower.includes("\\nonexistent") };
}
// Complete bounded LIST only. Discovery does not SELECT, read messages, subscribe, create, move or delete.
export async function discoverImapFolders(socket: ImapSocket, username: string, authentication: MailAuthentication, control?: MailSocketControl) {
  const wire = new ImapWire(socket, 256 * 1024, control);
  try {
    const capabilities = await openAuthenticatedImap(wire, username, authentication);
    const tag = await wire.start(`LIST "" "*"${capabilities.includes("SPECIAL-USE") ? " RETURN (SPECIAL-USE)" : ""}`);
    const folders: ImapFolder[] = [], names = new Set<string>();
    for (let count = 0; count < 256; count++) {
      const line = await wire.line(true);
      if (line.startsWith(`${tag} `)) {
        if (!new RegExp(`^${tag} OK(?: |$)`, "i").test(line)) throw new HttpError(502, "imap_command_failed");
        return { folders };
      }
      if (/^\* LIST /i.test(line)) {
        if (folders.length >= 128) throw new HttpError(502, "imap_folder_catalog_limit");
        const folder = await listFolder(wire, line);
        if (names.has(folder.wireName)) throw invalid();
        names.add(folder.wireName); folders.push(folder);
      } else if (!/^\* (?:OK|NO|BAD)(?: |$)/i.test(line) || /\{\d+\+?\}$/.test(line)) throw invalid();
    }
    throw new HttpError(502, "imap_response_limit");
  } finally { wire.release(); }
}
