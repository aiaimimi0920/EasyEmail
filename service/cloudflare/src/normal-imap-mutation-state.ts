import { HttpError } from "./http";

const uid = (value: string) => /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 4294967295;
export interface ImapDestinationUid { uidValidity: string; uid: number }
export function mutationMailboxState(lines: string[], completion: string, readOnly: boolean, expected?: string, deleted = false) {
  const mode = readOnly ? "READ-ONLY" : "READ-WRITE";
  if (!new RegExp(`^\\S+ OK \\[${mode}\\](?: |$)`, "i").test(completion)) throw new HttpError(409, "imap_mutation_read_only");
  const identities = lines.filter(line => /^\* (?:OK|NO|BAD) \[UIDVALIDITY(?: |\])/i.test(line));
  const validity = /^\* OK \[UIDVALIDITY ([1-9]\d{0,9})\](?: |$)/i.exec(identities[0] ?? "")?.[1];
  if (identities.length !== 1 || !validity || !uid(validity) || (expected !== undefined && expected !== validity)) throw new HttpError(409, "imap_mutation_epoch_changed");
  if (lines.some(line => /\[UIDNOTSTICKY\]/i.test(line))) throw new HttpError(502, "imap_uids_not_sticky");
  if (deleted) {
    const permanent = lines.filter(line => /^\* (?:OK|NO|BAD) \[PERMANENTFLAGS(?: |\])/i.test(line));
    const flags = /^\* OK \[PERMANENTFLAGS \(([^()]*)\)\](?: |$)/i.exec(permanent[0] ?? "")?.[1].split(/ +/);
    if (permanent.length !== 1 || !flags?.some(flag => flag.toLowerCase() === "\\deleted")) throw new HttpError(409, "imap_mutation_delete_not_permanent");
  }
  return validity;
}
function singleton(value: string) {
  const parts = value.split(":");
  if (!uid(parts[0]) || parts.length > 2 || (parts.length === 2 && parts[0] !== parts[1])) return null;
  return Number(parts[0]);
}
export function mutationCopyUid(lines: string[], completion: string, sourceUid: number, destinationValidity: string): ImapDestinationUid {
  const candidates = [...lines, completion].filter(line => /\[COPYUID(?: |\])/i.test(line));
  const match = /^(?:\*|\S+) OK \[COPYUID ([1-9]\d{0,9}) ([0-9:]+) ([0-9:]+)\](?: |$)/i.exec(candidates[0] ?? "");
  const destination = match && singleton(match[3]);
  if (candidates.length !== 1 || !match || match[1] !== destinationValidity || singleton(match[2]) !== sourceUid || destination === null) {
    throw new HttpError(502, "imap_mutation_mapping_unconfirmed");
  }
  return { uidValidity: match[1], uid: destination };
}
