import { HttpError } from "./http";
import { ImapWire, type ImapSocket } from "./normal-imap-wire";
import { openAuthenticatedImap, imapCapabilities } from "./normal-imap-protocol";
import { readFlags } from "./normal-imap-flags";
import { imapFolderName } from "./normal-imap-folder-names";
import { mutationCopyUid, mutationMailboxState, type ImapDestinationUid } from "./normal-imap-mutation-state";
import type { MailAuthentication } from "./mail-authentication";
import type { MailSocketControl } from "./mail-socket-session";

export interface ImapMutationCommand { uid: number; uidValidity: string; action: "move" | "delete" }
export type ImapMutationPhase = "move" | "copy" | "mark-deleted" | "expunge";
export interface ImapMutationResult { method: "move" | "copy-expunge" | "delete"; sourceRemoved: true; destination: ImapDestinationUid | null }
export type ImapMutationDispatch = (phase: ImapMutationPhase, destination?: ImapDestinationUid, destinationValidity?: string) => Promise<void>;
export type ImapMutationObserve = (destination: ImapDestinationUid) => Promise<void>;
export function assertImapMutationCommand(command: ImapMutationCommand, source: string, destination?: string) {
  if (!command || Object.keys(command).some(key => !["uid", "uidValidity", "action"].includes(key))
    || !Number.isSafeInteger(command.uid) || command.uid < 1 || command.uid > 4294967295
    || typeof command.uidValidity !== "string" || !/^[1-9]\d{0,9}$/.test(command.uidValidity) || Number(command.uidValidity) > 4294967295
    || !["move", "delete"].includes(command.action)) throw new HttpError(400, "invalid_remote_mutation_request");
  const from = imapFolderName(source).wireName;
  if (command.action === "move" ? !destination || imapFolderName(destination).wireName === from : destination !== undefined) {
    throw new HttpError(400, "invalid_remote_mutation_request");
  }
}
const argument = (value: string) => value === "INBOX" ? "INBOX" : `"${value.replace(/["\\]/g, "\\$&")}"`;
// The caller durably authorizes every irreversible phase. No reconnect, blanket EXPUNGE, or automatic compensation.
export async function mutateImapMessage(socket: ImapSocket, username: string, authentication: MailAuthentication,
  command: ImapMutationCommand, beforeDispatch: ImapMutationDispatch, control?: MailSocketControl, source = "INBOX", destination?: string,
  observeDestination?: ImapMutationObserve): Promise<ImapMutationResult> {
  assertImapMutationCommand(command, source, destination);
  if (typeof beforeDispatch !== "function" || (observeDestination !== undefined && typeof observeDestination !== "function")) {
    throw new HttpError(400, "invalid_remote_mutation_request");
  }
  const from = imapFolderName(source).wireName, to = destination === undefined ? undefined : imapFolderName(destination).wireName;
  const wire = new ImapWire(socket, 65536, control);
  const dispatch = async (phase: ImapMutationPhase, mapping?: ImapDestinationUid) => {
    control?.assertActive(); await beforeDispatch(phase, mapping, destinationValidity); control?.assertActive();
  };
  let destinationValidity: string | undefined;
  try {
    await openAuthenticatedImap(wire, username, authentication);
    const capabilities = await imapCapabilities(wire);
    const nativeMove = command.action === "move" && (capabilities.includes("MOVE") || capabilities.includes("IMAP4REV2"));
    if (!nativeMove && !capabilities.includes("UIDPLUS") && !capabilities.includes("IMAP4REV2")) throw new HttpError(409, "imap_mutation_unsupported");
    if (to !== undefined) destinationValidity = mutationMailboxState(await wire.command(`EXAMINE ${argument(to)}`), wire.completion, true);
    mutationMailboxState(await wire.command(`SELECT ${argument(from)}`), wire.completion, false, command.uidValidity, !nativeMove);
    if (await readFlags(wire, command.uid, true) === null) throw new HttpError(409, "imap_mutation_message_missing");
    let mapping: ImapDestinationUid | undefined;
    if (command.action === "move") {
      await dispatch(nativeMove ? "move" : "copy");
      const copied = await wire.command(`UID ${nativeMove ? "MOVE" : "COPY"} ${command.uid} ${argument(to!)}`);
      mapping = mutationCopyUid(copied, wire.completion, command.uid, destinationValidity!);
      // This is evidence of an already dispatched command, not permission for any following command.
      await observeDestination?.(mapping); control?.assertActive();
    }
    if (!nativeMove) {
      await dispatch("mark-deleted", mapping); await wire.command(`UID STORE ${command.uid} +FLAGS.SILENT (\\Deleted)`);
      const flags = await readFlags(wire, command.uid, true);
      if (!flags?.some(flag => flag.toLowerCase() === "\\deleted")) throw new HttpError(502, "imap_mutation_unconfirmed");
      await dispatch("expunge", mapping); await wire.command(`UID EXPUNGE ${command.uid}`);
    }
    if (await readFlags(wire, command.uid, true) !== null) throw new HttpError(502, "imap_mutation_unconfirmed");
    return { method: command.action === "delete" ? "delete" : nativeMove ? "move" : "copy-expunge", sourceRemoved: true, destination: mapping ?? null };
  } finally { wire.release(); }
}
