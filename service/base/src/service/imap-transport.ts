import net from "node:net";
import {
  ImapFlow,
  type FetchMessageObject,
  type ImapFlowOptions,
  type ListResponse,
  type MailboxLockObject,
  type MessageStructureObject,
} from "imapflow";

import type { MailAccountImapProfile } from "../domain/account.js";
import { EasyEmailError } from "../domain/errors.js";
import {
  normalizeNewsletterListId,
  parseUnsubscribeHeaderMethods,
} from "../domain/mail-extensions.js";
import type {
  MailImapFolderSyncBatch,
  MailImapMessageBody,
  MailImapMoveResult,
  MailImapRemoteFlag,
  MailImapRemoteFolder,
  MailImapRemoteMessageHeader,
  MailImapTransport,
} from "../domain/mail-imap-sync.js";
import type {
  MailImapConnectionTester,
  MailImapConnectionTestResult,
} from "./account-connectivity.js";
import {
  classifyImapFolderKind,
  createDefaultInboxFolder,
} from "./imap-folder-classifier.js";
import {
  extractStructuredMimeHeaders,
  parseImapRfc822MessageBody,
} from "./imap-mime-parser.js";
import { decodeMimeHeaderWords, parseSenderHeader } from "./mail-header-codec.js";

const DEFAULT_CONNECTION_TIMEOUT_MS = 12_000;
const HEADER_FETCH_NAMES = [
  "subject",
  "from",
  "date",
  "message-id",
  "in-reply-to",
  "references",
  "list-unsubscribe",
  "list-id",
  "precedence",
];

export type ImapFlowTransportClient = Pick<
  ImapFlow,
  | "capabilities"
  | "mailbox"
  | "connect"
  | "logout"
  | "close"
  | "list"
  | "getMailboxLock"
  | "fetchAll"
  | "fetchOne"
  | "messageFlagsAdd"
  | "messageFlagsRemove"
  | "messageDelete"
  | "messageMove"
>;

export type ImapFlowTransportClientFactory = (options: ImapFlowOptions) => ImapFlowTransportClient;

export interface ImapFlowTransportOptions {
  connectionTimeoutMs?: number;
  rejectUnauthorized?: boolean;
  ca?: string | Buffer | Array<string | Buffer>;
  createClient?: ImapFlowTransportClientFactory;
}

function isAuthenticationFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as { authenticationFailed?: unknown; responseStatus?: unknown; responseText?: unknown };
  if (record.authenticationFailed === true) {
    return true;
  }
  const text = typeof record.responseText === "string" ? record.responseText.toUpperCase() : "";
  return text.includes("AUTHENTICATIONFAILED") || text.includes("INVALID CREDENTIALS");
}

function mapImapTransportError(error: unknown, fallbackMessage: string): EasyEmailError {
  if (error instanceof EasyEmailError) {
    return error;
  }
  if (isAuthenticationFailure(error)) {
    return new EasyEmailError("IMAP_AUTH_FAILED", "The IMAP server rejected the account credential.");
  }
  const detail = error instanceof Error && error.message ? error.message : fallbackMessage;
  return new EasyEmailError("IMAP_UNAVAILABLE", detail);
}

async function logoutQuietly(client: ImapFlowTransportClient, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.logout(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("IMAP logout timed out.")), timeoutMs);
      }),
    ]);
  } catch {
    client.close();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function structureHasAttachments(node: MessageStructureObject | undefined): boolean {
  if (!node) return false;
  const disposition = node.disposition?.toLowerCase();
  if (disposition === "attachment" || Boolean(node.dispositionParameters?.filename)) {
    return true;
  }
  return Boolean(node.childNodes?.some((child) => structureHasAttachments(child)));
}

function toIsoTimestamp(value: Date | string | undefined): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return new Date().toISOString();
}

function mapFetchedHeader(item: FetchMessageObject): MailImapRemoteMessageHeader | undefined {
  if (!Number.isSafeInteger(item.uid) || item.uid <= 0) {
    return undefined;
  }
  const rawHeaders = item.headers ? extractStructuredMimeHeaders(item.headers) : undefined;
  const envelopeFrom = item.envelope?.from?.[0];
  const parsedRawFrom = rawHeaders?.from ? parseSenderHeader(rawHeaders.from) : undefined;
  const fromAddress = envelopeFrom?.address?.trim()
    || parsedRawFrom?.fromAddress
    || "";
  const fromName = (envelopeFrom?.name ? decodeMimeHeaderWords(envelopeFrom.name) : undefined)
    || parsedRawFrom?.fromName;
  const subject =
    (item.envelope?.subject ? decodeMimeHeaderWords(item.envelope.subject) : undefined)
    || rawHeaders?.subject
    || "(no subject)";
  const rfcMessageId = item.envelope?.messageId?.trim() || rawHeaders?.messageId;
  const inReplyTo = item.envelope?.inReplyTo?.trim() || rawHeaders?.inReplyTo;
  const observedAt = toIsoTimestamp(item.envelope?.date ?? rawHeaders?.date ?? item.internalDate);
  const flags = item.flags ?? new Set<string>();
  const lowerFlags = new Set([...flags].map((flag) => flag.toLowerCase()));
  const isNewsletter = Boolean(
    rawHeaders?.listUnsubscribe
    || rawHeaders?.listId
    || (rawHeaders?.precedence && /^(?:bulk|list)$/iu.test(rawHeaders.precedence.trim())),
  );
  const newsletterListId = normalizeNewsletterListId(rawHeaders?.listId);
  const newsletterUnsubscribeMethods = parseUnsubscribeHeaderMethods(rawHeaders?.listUnsubscribe);

  return {
    uid: String(item.uid),
    ...(rfcMessageId ? { rfcMessageId } : {}),
    ...(inReplyTo ? { inReplyTo } : {}),
    references: rawHeaders?.references ?? [],
    subject,
    fromAddress,
    ...(fromName ? { fromName } : {}),
    observedAt,
    snippet: subject.slice(0, 240),
    isRead: lowerFlags.has("\\seen"),
    isStarred: lowerFlags.has("\\flagged"),
    isDeleted: lowerFlags.has("\\deleted"),
    hasAttachments: structureHasAttachments(item.bodyStructure),
    isNewsletter,
    ...(newsletterListId ? { newsletterListId } : {}),
    ...(newsletterUnsubscribeMethods.length > 0 ? { newsletterUnsubscribeMethods } : {}),
  };
}

export class ImapFlowTransport implements MailImapTransport, MailImapConnectionTester {
  private readonly timeoutMs: number;
  private readonly rejectUnauthorized: boolean;
  private readonly ca?: string | Buffer | Array<string | Buffer>;
  private readonly createClient: ImapFlowTransportClientFactory;

  public constructor(options: ImapFlowTransportOptions = {}) {
    const timeout = options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 60_000) {
      throw new Error("IMAP connection timeout must be an integer from 100 to 60000 milliseconds.");
    }
    this.timeoutMs = timeout;
    this.rejectUnauthorized = options.rejectUnauthorized ?? true;
    this.ca = options.ca;
    this.createClient = options.createClient ?? ((clientOptions) => new ImapFlow(clientOptions));
  }

  private async withConnectedClient<T>(
    profile: MailAccountImapProfile,
    secret: string,
    operation: (client: ImapFlowTransportClient) => Promise<T>,
  ): Promise<T> {
    const sniServername = net.isIP(profile.host) === 0 ? profile.host : undefined;
    const client = this.createClient({
      host: profile.host,
      port: profile.port,
      secure: profile.security === "tls",
      doSTARTTLS: profile.security === "starttls" ? true : undefined,
      auth: { user: profile.username, pass: secret },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: this.timeoutMs,
      greetingTimeout: this.timeoutMs,
      socketTimeout: this.timeoutMs,
      tls: {
        minVersion: "TLSv1.2",
        rejectUnauthorized: this.rejectUnauthorized,
        ...(this.ca !== undefined ? { ca: this.ca } : {}),
        ...(sniServername !== undefined ? { servername: sniServername } : {}),
      },
    });
    let connected = false;
    try {
      await client.connect();
      connected = true;
      return await operation(client);
    } catch (error) {
      throw mapImapTransportError(error, "Could not complete IMAP operation.");
    } finally {
      if (connected) {
        await logoutQuietly(client, this.timeoutMs);
      } else {
        client.close();
      }
    }
  }

  public async testConnection(
    profile: MailAccountImapProfile,
    secret: string,
  ): Promise<MailImapConnectionTestResult> {
    return this.withConnectedClient(profile, secret, async (client) => {
      const capabilities = [...client.capabilities.keys()]
        .map((value) => value.trim())
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right));
      return {
        authenticated: true,
        capabilitySummary: capabilities.length > 0 ? capabilities.join(" ") : "IMAP authenticated",
      };
    });
  }

  public async discoverFolders(
    profile: MailAccountImapProfile,
    secret: string,
  ): Promise<MailImapRemoteFolder[]> {
    return this.withConnectedClient(profile, secret, async (client) => {
      const listed: ListResponse[] = await client.list();
      const selectable = listed.filter(
        (entry) => !entry.flags || ![...entry.flags].some((flag) => flag.toLowerCase() === "\\noselect"),
      );
      if (selectable.length === 0) {
        return [createDefaultInboxFolder()];
      }
      return selectable.map((entry) => ({
        providerFolderId: entry.path,
        displayName: entry.name || entry.path,
        path: entry.path,
        delimiter: entry.delimiter || "/",
        folderKind: classifyImapFolderKind(entry.path, entry.specialUse, entry.flags),
        ...(entry.specialUse ? { specialUse: entry.specialUse } : {}),
      }));
    });
  }

  public async syncFolderHeaders(
    profile: MailAccountImapProfile,
    secret: string,
    options: {
      folderPath: string;
      knownUidValidity?: string;
      lastSeenUid?: string;
      limit: number;
    },
  ): Promise<MailImapFolderSyncBatch> {
    return this.withConnectedClient(profile, secret, async (client) => {
      const lock: MailboxLockObject = await client.getMailboxLock(options.folderPath, {
        readOnly: true,
      });
      try {
        const mailbox = client.mailbox;
        if (!mailbox) {
          throw new EasyEmailError("IMAP_UNAVAILABLE", "IMAP mailbox selection did not expose state.");
        }
        const uidValidity = String(mailbox.uidValidity ?? 0n);
        const uidValidityChanged = Boolean(
          options.knownUidValidity
          && options.knownUidValidity !== uidValidity,
        );
        if (mailbox.exists <= 0 || options.limit <= 0) {
          return {
            uidValidity,
            uidValidityChanged,
            headers: [],
          };
        }

        const query = {
          uid: true,
          flags: true,
          envelope: true,
          internalDate: true,
          bodyStructure: true,
          headers: HEADER_FETCH_NAMES,
        };

        let fetched: FetchMessageObject[];
        const parsedLastUid = !uidValidityChanged && options.lastSeenUid && /^\d+$/u.test(options.lastSeenUid)
          ? Number(options.lastSeenUid)
          : undefined;

        if (parsedLastUid !== undefined && Number.isSafeInteger(parsedLastUid) && parsedLastUid >= 1) {
          if (typeof mailbox.uidNext === "number" && mailbox.uidNext <= parsedLastUid + 1) {
            fetched = [];
          } else {
            const incremental = await client.fetchAll(`${parsedLastUid + 1}:*`, query, { uid: true });
            fetched = incremental.filter((item) => item.uid > parsedLastUid).slice(-options.limit);
          }
        } else {
          const count = Math.min(options.limit, mailbox.exists);
          const startSeq = Math.max(1, mailbox.exists - count + 1);
          fetched = await client.fetchAll(`${startSeq}:${mailbox.exists}`, query);
        }

        const headers = fetched
          .map(mapFetchedHeader)
          .filter((item): item is MailImapRemoteMessageHeader => item !== undefined)
          .sort((left, right) => Number(right.uid) - Number(left.uid));
        const highestSeenUid = headers.reduce<string | undefined>((best, current) => {
          if (!best) return current.uid;
          return BigInt(current.uid) > BigInt(best) ? current.uid : best;
        }, undefined);

        return {
          uidValidity,
          uidValidityChanged,
          ...(highestSeenUid ? { highestSeenUid } : {}),
          headers,
        };
      } finally {
        lock.release();
      }
    });
  }

  public async fetchMessageBody(
    profile: MailAccountImapProfile,
    secret: string,
    folderPath: string,
    uid: string,
  ): Promise<MailImapMessageBody | undefined> {
    if (!/^[1-9]\d*$/u.test(uid)) {
      throw new EasyEmailError("INVALID_MAIL_MESSAGE", "IMAP message UID is invalid.");
    }
    return this.withConnectedClient(profile, secret, async (client) => {
      const lock = await client.getMailboxLock(folderPath, { readOnly: true });
      try {
        const fetched = await client.fetchOne(uid, { uid: true, source: true }, { uid: true });
        if (!fetched || !fetched.source) {
          return undefined;
        }
        return parseImapRfc822MessageBody(fetched.source);
      } finally {
        lock.release();
      }
    });
  }

  public async setMessageFlag(
    profile: MailAccountImapProfile,
    secret: string,
    folderPath: string,
    uid: string,
    flag: MailImapRemoteFlag,
    enabled: boolean,
  ): Promise<void> {
    if (!/^[1-9]\d*$/u.test(uid)) {
      throw new EasyEmailError("INVALID_MAIL_MESSAGE", "IMAP message UID is invalid.");
    }
    await this.withConnectedClient(profile, secret, async (client) => {
      const lock = await client.getMailboxLock(folderPath, { readOnly: false });
      try {
        if (flag === "\\Deleted" && enabled) {
          await client.messageDelete(uid, { uid: true });
          return;
        }
        if (enabled) {
          await client.messageFlagsAdd(uid, [flag], { uid: true, silent: true });
        } else {
          await client.messageFlagsRemove(uid, [flag], { uid: true, silent: true });
        }
      } finally {
        lock.release();
      }
    });
  }

  public async moveMessage(
    profile: MailAccountImapProfile,
    secret: string,
    sourceFolderPath: string,
    uid: string,
    targetFolderPath: string,
  ): Promise<MailImapMoveResult> {
    if (!/^[1-9]\d*$/u.test(uid)) {
      throw new EasyEmailError("INVALID_MAIL_MESSAGE", "IMAP message UID is invalid.");
    }
    if (sourceFolderPath === targetFolderPath) {
      return {};
    }
    return this.withConnectedClient(profile, secret, async (client) => {
      const lock = await client.getMailboxLock(sourceFolderPath, { readOnly: false });
      try {
        const moved = await client.messageMove(uid, targetFolderPath, { uid: true });
        if (!moved) {
          throw new EasyEmailError("IMAP_UNAVAILABLE", "IMAP server rejected the message move.");
        }
        const mappedUid = moved.uidMap?.get(Number(uid));
        return {
          ...(mappedUid !== undefined ? { targetUid: String(mappedUid) } : {}),
          ...(moved.uidValidity !== undefined ? { targetUidValidity: String(moved.uidValidity) } : {}),
        };
      } finally {
        lock.release();
      }
    });
  }
}
