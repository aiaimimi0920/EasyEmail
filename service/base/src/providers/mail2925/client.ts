import type { CredentialSetDefinition } from "../../shared/index.js";
import type { ObservedMessage, ProviderInstance } from "../../domain/models.js";
import { buildAliasAddress } from "./alias.js";
import { resolveMail2925Config } from "./configuration.js";
import { classifyMail2925Error } from "./failure.js";
import {
  asRecord,
  extractFolderNames,
  extractMessageList,
  readEnvelopeResult,
} from "./payload.js";
import { tryReadLatestMail2925Code } from "./polling.js";
import { Mail2925Session } from "./session.js";
import type {
  Mail2925AccountCredential,
  Mail2925Config,
  Mail2925MailboxRefPayload,
} from "./types.js";

export { resolveMail2925Config, resolveMail2925CredentialSets } from "./configuration.js";
export { decodeMail2925MailboxRef, encodeMail2925MailboxRef } from "./mailbox-ref.js";
export type { Mail2925Config, Mail2925MailboxRefPayload } from "./types.js";

export class Mail2925Client {
  private readonly session: Mail2925Session;

  public constructor(private readonly config: Mail2925Config) {
    this.session = new Mail2925Session(config);
  }

  public static fromInstance(
    instance: ProviderInstance,
    credentialSets?: CredentialSetDefinition[],
  ): Mail2925Client | undefined {
    const config = resolveMail2925Config(instance, credentialSets);
    if (config.credentialSets.length === 0) return undefined;
    return new Mail2925Client(config);
  }

  public resolveBoundCredential(
    mailbox: Mail2925MailboxRefPayload,
  ): Mail2925AccountCredential | undefined {
    return this.session.resolveBoundCredential(mailbox);
  }

  public async listFolders(account: Mail2925AccountCredential): Promise<string[]> {
    const body = await this.session.requestAuthorized(account, "GET", "/mailv2/UserData/folders", {
      query: { accountName: account.accountEmail },
    });
    return extractFolderNames(body);
  }

  public async createMailbox(options: {
    sessionHint: string;
    requestedDomain?: string;
    createdAt?: string;
  }): Promise<Mail2925MailboxRefPayload> {
    return this.session.withCredential("generate", options.sessionHint, async (account) => {
      await this.session.login(account);
      const aliasAddress = buildAliasAddress(
        account,
        options.sessionHint,
        this.config.aliasSeparator,
        this.config.aliasSuffixLength,
        options.requestedDomain,
      );
      return {
        aliasAddress,
        accountEmail: account.accountEmail,
        folderName: this.config.folderName,
        credentialSetId: account.selection.set.id,
        credentialItemId: account.selection.item.id,
        createdAt: options.createdAt,
      };
    });
  }

  public async listMessages(
    account: Mail2925AccountCredential,
    folderName = this.config.folderName,
  ): Promise<Record<string, unknown>[]> {
    const body = await this.session.requestAuthorized(
      account,
      "GET",
      "/mailv2/maildata/MailList/mails",
      {
        query: {
          Folder: folderName,
          MailBox: account.accountEmail,
          FilterType: 0,
          PageIndex: 0,
          PageCount: 20,
        },
      },
    );
    return extractMessageList(body);
  }

  public async getMessage(
    account: Mail2925AccountCredential,
    messageId: string,
    folderName = this.config.folderName,
  ): Promise<Record<string, unknown>> {
    try {
      const body = await this.session.requestAuthorized(
        account,
        "GET",
        "/mailv2/maildata/MailRead/mails/read",
        {
          query: {
            MessageID: messageId,
            FolderName: folderName,
            MailBox: account.accountEmail,
            IsPre: false,
          },
        },
      );
      return asRecord(readEnvelopeResult(body));
    } catch (error) {
      if (!this.session.canRefreshConfiguredSessionToken()) throw error;
      return this.session.getMessageWithPythonFallback(account, messageId, folderName);
    }
  }

  public async tryReadLatestCode(
    sessionId: string,
    mailbox: Mail2925MailboxRefPayload,
    providerInstanceId: string,
    fromContains?: string,
  ): Promise<ObservedMessage | undefined> {
    return this.session.withBoundCredential(mailbox, async (account) => tryReadLatestMail2925Code({
      sessionId,
      mailbox,
      providerInstanceId,
      fromContains,
      account,
      defaultFolderName: this.config.folderName,
      listMessages: (folderName) => this.listMessages(account, folderName),
      getMessage: (messageId, folderName) => this.getMessage(account, messageId, folderName),
    }));
  }
}

export async function probeMail2925Instance(
  instance: ProviderInstance,
  credentialSets?: CredentialSetDefinition[],
): Promise<{
  ok: boolean;
  detail: string;
  averageLatencyMs: number;
  metadata?: Record<string, string>;
}> {
  const client = Mail2925Client.fromInstance(instance, credentialSets);
  if (!client) {
    return {
      ok: false,
      detail: "2925 instance is missing credentialSets/account/password/accountsFile configuration.",
      averageLatencyMs: instance.averageLatencyMs,
    };
  }

  const startedAt = Date.now();
  try {
    const probeMailbox = await client.createMailbox({
      sessionHint: "probe",
      createdAt: new Date(startedAt).toISOString(),
    });
    const account = client.resolveBoundCredential(probeMailbox);
    const folders = account ? await client.listFolders(account) : [];

    return {
      ok: folders.includes("Inbox"),
      detail: folders.includes("Inbox")
        ? `MAIL2925_PROBE_OK: 2925 login succeeded and returned ${folders.length} folders.`
        : "MAIL2925_MAILBOX_DELIVERY_FAILURE: 2925 login succeeded but Inbox was not visible.",
      averageLatencyMs: Date.now() - startedAt,
      metadata: {
        provider: "mail2925",
        accountEmail: probeMailbox.accountEmail,
        folders: String(folders.length),
      },
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      averageLatencyMs: Date.now() - startedAt,
      metadata: {
        provider: "mail2925",
        errorClass: classifyMail2925Error(error instanceof Error ? error.message : String(error)),
      },
    };
  }
}
