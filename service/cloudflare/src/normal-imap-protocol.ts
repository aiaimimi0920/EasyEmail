import { HttpError } from "./http";
import { ImapWire, type ImapSocket } from "./normal-imap-wire";
import type { MailSocketControl } from "./mail-socket-session";
import { mailSasl, type MailAuthentication } from "./mail-authentication";
import { authenticateImap } from "./normal-imap-auth";
import { imapFolderName } from "./normal-imap-folder-names";
export async function imapCapabilities(wire: ImapWire) {
  const advertised = await wire.command("CAPABILITY");
  const capabilities = [...new Set(advertised.filter(line => /^\* CAPABILITY /i.test(line))
    .flatMap(line => line.slice(13).trim().split(/ +/)).map(value => value.toUpperCase()))];
  if (capabilities.some(value => !/^[A-Z0-9=+._-]{1,80}$/.test(value))) throw new HttpError(502, "imap_protocol_invalid");
  return capabilities;
}
export async function openAuthenticatedImap(wire: ImapWire, username: string, authentication: MailAuthentication) {
  const sasl = mailSasl(username, authentication);
  await wire.socket.opened;
  if (!/^\* OK(?: |$)/i.test(await wire.line())) throw new HttpError(502, "imap_greeting_invalid");
  let advertised = await imapCapabilities(wire);
  if (wire.needsStartTls) {
    if (!advertised.includes("STARTTLS")) throw new HttpError(502, "imap_starttls_unavailable");
    await wire.command("STARTTLS"); await wire.startTls();
    advertised = await imapCapabilities(wire);
  }
  await authenticateImap(wire, advertised, sasl);
  return advertised;
}
export async function openImapMailbox(wire: ImapWire, username: string, authentication: MailAuthentication, path = "INBOX") {
  const name = imapFolderName(path).wireName, argument = name === "INBOX" ? "INBOX" : `"${name.replace(/["\\]/g, "\\$&")}"`;
  const advertised = await openAuthenticatedImap(wire, username, authentication);
  const inbox = await wire.command(`EXAMINE ${argument}`);
  if (!/^\S+ OK \[READ-ONLY\](?: |$)/i.test(wire.completion)) throw new HttpError(502, "imap_not_read_only");
  const identities = inbox.filter(line => /^\* (?:OK|NO|BAD) \[UIDVALIDITY(?: |\])/i.test(line));
  const counts = inbox.filter(line => /^\* \S+ EXISTS(?: |$)/i.test(line));
  const validity = /^\* OK \[UIDVALIDITY ([1-9]\d{0,9})\](?: |$)/i.exec(identities[0] ?? "")?.[1];
  const count = /^\* (\d{1,10}) EXISTS$/i.exec(counts[0] ?? "")?.[1];
  if (identities.length !== 1 || counts.length !== 1 || !validity || Number(validity) > 4294967295
    || count === undefined || Number(count) > 4294967295) throw new HttpError(502, "imap_inbox_identity_missing");
  return { capabilities: advertised, inbox: { path: name, uidValidity: validity, messages: Number(count) }, responses: inbox };
}
export const openImapInbox = (wire: ImapWire, username: string, authentication: MailAuthentication) => openImapMailbox(wire, username, authentication);
// Only authenticated read-only discovery. No SELECT, FETCH, STORE, MOVE or SMTP commands.
export async function inspectImapInbox(socket: ImapSocket, username: string, authentication: MailAuthentication, control?: MailSocketControl) {
  const wire = new ImapWire(socket, 65536, control);
  try {
    const { capabilities, inbox } = await openImapInbox(wire, username, authentication);
    await wire.write("eeLogout LOGOUT");
    return { authenticated: true, readOnly: true, capabilities, inbox };
  } finally { wire.release(); }
}
