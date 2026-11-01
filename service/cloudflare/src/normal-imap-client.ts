import { HttpError } from "./http";
import { withMailSocket } from "./mail-socket-session";
import type { ImapEndpoint } from "./normal-account-input";
import { inspectImapInbox } from "./normal-imap-protocol";
import { assertImapCursor, readImapBatch, type ImapCursor } from "./normal-imap-read";
import { assertMailAuthentication, type MailAuthentication } from "./mail-authentication";
import { assertImapFlagCommand, changeImapFlags, type ImapFlagCommand } from "./normal-imap-flags";
import { discoverImapFolders } from "./normal-imap-folders";
import { imapFolderName } from "./normal-imap-folder-names";
import { assertImapMutationCommand, mutateImapMessage, type ImapMutationCommand, type ImapMutationDispatch, type ImapMutationObserve } from "./normal-imap-mutations";
function imapError(error: unknown): never {
  if (error instanceof HttpError) throw error;
  throw new HttpError(502, "imap_connection_failed");
}
export async function listImapFolders(endpoint: ImapEndpoint, username: string, authentication: MailAuthentication) {
  assertMailAuthentication(username, authentication);
  return withMailSocket(endpoint, "imap", (socket, control) => discoverImapFolders(socket, username, authentication, control)).catch(imapError);
}
export async function testImapConnection(endpoint: ImapEndpoint, username: string, authentication: MailAuthentication) {
  assertMailAuthentication(username, authentication);
  return withMailSocket(endpoint, "imap", (socket, control) => inspectImapInbox(socket, username, authentication, control)).catch(imapError);
}
export async function readImapMessages(endpoint: ImapEndpoint, username: string, authentication: MailAuthentication, cursor: ImapCursor | null = null) {
  assertImapCursor(cursor); assertMailAuthentication(username, authentication);
  return withMailSocket(endpoint, "imap", (socket, control) => readImapBatch(socket, username, authentication, cursor, control)).catch(imapError);
}
export async function readImapFolderMessages(endpoint: ImapEndpoint, username: string, authentication: MailAuthentication, wireName: string, cursor: ImapCursor | null) {
  assertImapCursor(cursor); assertMailAuthentication(username, authentication); imapFolderName(wireName);
  return withMailSocket(endpoint, "imap", (socket, control) => readImapBatch(socket, username, authentication, cursor, control, wireName)).catch(imapError);
}
export async function writeImapFlag(endpoint: ImapEndpoint, username: string, authentication: MailAuthentication,
  command: ImapFlagCommand, beforeDispatch: () => Promise<void>, wireName = "INBOX") {
  assertImapFlagCommand(command); assertMailAuthentication(username, authentication); imapFolderName(wireName);
  return withMailSocket(endpoint, "imap", (socket, control) => changeImapFlags(socket, username, authentication, command, beforeDispatch, control, wireName)).catch(imapError);
}

export async function writeImapMutation(endpoint: ImapEndpoint, username: string, authentication: MailAuthentication,
  command: ImapMutationCommand, beforeDispatch: ImapMutationDispatch, source = "INBOX", destination?: string, observeDestination?: ImapMutationObserve) {
  assertImapMutationCommand(command, source, destination); assertMailAuthentication(username, authentication);
  if (typeof beforeDispatch !== "function" || (observeDestination !== undefined && typeof observeDestination !== "function")) {
    throw new HttpError(400, "invalid_remote_mutation_request");
  }
  const snapshot = { ...command };
  return withMailSocket(endpoint, "imap", (socket, control) =>
    mutateImapMessage(socket, username, authentication, snapshot, beforeDispatch, control, source, destination, observeDestination)).catch(imapError);
}
