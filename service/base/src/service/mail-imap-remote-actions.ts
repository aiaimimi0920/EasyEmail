import type { MailAccountRepository } from "../domain/account.js";
import { EasyEmailError } from "../domain/errors.js";
import type {
  MailImapFolder,
  MailImapFolderKind,
  MailImapMessageSourceContext,
  MailImapRepository,
  MailImapTransport,
} from "../domain/mail-imap-sync.js";
import type {
  MailMessageFlagName,
  MailMessageLocalActionResult,
  MailMessageRepository,
} from "../domain/mail-message.js";
import type { MailCredentialResolver } from "./account-connectivity.js";
import { extractSnippetFromBodies, sanitizeMailHtml } from "./mail-html-sanitizer.js";
import { resolveAccountImapSecret } from "./mail-imap-sync.js";
import type { MailVerificationService } from "./mail-verifications.js";

export interface MailImapRemoteActionDependencies {
  imapRepository?: MailImapRepository;
  accountRepository?: MailAccountRepository;
  credentialResolver?: MailCredentialResolver;
  imapTransport?: MailImapTransport;
  verificationService?: MailVerificationService;
}

function remoteFolderKindForLocalFolder(folderName: string): MailImapFolderKind | undefined {
  if (
    folderName === "inbox"
    || folderName === "spam"
    || folderName === "trash"
    || folderName === "archive"
  ) {
    return folderName;
  }
  return undefined;
}

export class MailImapRemoteActions {
  public constructor(
    private readonly messageRepository: MailMessageRepository,
    private readonly dependencies: MailImapRemoteActionDependencies,
  ) {}

  public async hydrateMessageBodyIfNeeded(messageId: string, nowIso: string): Promise<void> {
    const {
      imapRepository,
      accountRepository,
      credentialResolver,
      imapTransport,
      verificationService,
    } = this.dependencies;
    if (!imapRepository || !accountRepository || !credentialResolver || !imapTransport) {
      return;
    }

    const context = await imapRepository.getImapMessageSourceContext(messageId);
    if (!context || context.bodyCacheState === "cached") {
      return;
    }

    const account = await accountRepository.getMailAccount(context.accountId);
    if (!account?.imap || account.status === "disabled") {
      return;
    }

    try {
      const { secret } = await resolveAccountImapSecret({
        account,
        accountRepository,
        credentialResolver,
        useCase: "imap-action",
        nowIso,
      });
      const fetched = await imapTransport.fetchMessageBody(
        account.imap,
        secret,
        context.folderPath,
        context.imapUid,
      );
      if (!fetched) {
        return;
      }
      const sanitizedHtml = fetched.bodyHtml ? sanitizeMailHtml(fetched.bodyHtml) : undefined;
      const snippet = extractSnippetFromBodies(fetched.bodyText, sanitizedHtml, "");
      await imapRepository.cacheMailMessageBody(
        messageId,
        fetched.bodyText,
        sanitizedHtml,
        snippet,
        fetched.hasAttachments,
        nowIso,
      );
      await verificationService?.classifyStoredMessage(messageId, { missingIsError: false });
    } catch (error) {
      // Offline / transient network errors during detail open leave cached header/snippet readable.
      if (
        error instanceof EasyEmailError
        && (error.code === "IMAP_UNAVAILABLE" || error.code === "ACCOUNT_CREDENTIAL_UNAVAILABLE")
      ) {
        return;
      }
      throw error;
    }
  }

  private async resolveContextAndTransport(
    messageId: string,
    nowIso: string,
  ): Promise<
    | {
        context: MailImapMessageSourceContext;
        imapRepository: MailImapRepository;
        imapTransport: MailImapTransport;
        account: NonNullable<Awaited<ReturnType<MailAccountRepository["getMailAccount"]>>>;
        secret: string;
      }
    | undefined
  > {
    const { imapRepository, accountRepository, credentialResolver, imapTransport } =
      this.dependencies;
    if (!imapRepository) {
      return undefined;
    }
    const context = await imapRepository.getImapMessageSourceContext(messageId);
    if (!context) {
      return undefined;
    }
    if (!accountRepository || !imapTransport) {
      throw new EasyEmailError(
        "IMAP_UNAVAILABLE",
        "Remote IMAP actions are unavailable in this runtime; refusing to apply a local-only mutation.",
      );
    }
    const account = await accountRepository.getMailAccount(context.accountId);
    if (!account?.imap) {
      throw new EasyEmailError(
        "ACCOUNT_IMAP_PROFILE_MISSING",
        "Account IMAP profile is missing for remote message action.",
      );
    }
    const { secret } = await resolveAccountImapSecret({
      account,
      accountRepository,
      credentialResolver,
      useCase: "imap-action",
      nowIso,
    });
    return { context, imapRepository, imapTransport, account, secret };
  }

  private async resolveTargetImapFolder(
    imapRepository: MailImapRepository,
    imapTransport: MailImapTransport,
    accountId: string,
    sourceRefId: string,
    profile: NonNullable<Awaited<ReturnType<MailAccountRepository["getMailAccount"]>>>["imap"],
    secret: string,
    selector: { folderKind?: MailImapFolderKind; folderName?: string },
    nowIso: string,
  ): Promise<MailImapFolder | undefined> {
    const matchFolder = (folders: MailImapFolder[]): MailImapFolder | undefined => {
      if (selector.folderKind) {
        const byKind = folders.find((folder) => folder.folderKind === selector.folderKind);
        if (byKind) return byKind;
      }
      if (selector.folderName) {
        const needle = selector.folderName.trim().toLowerCase();
        return folders.find(
          (folder) =>
            folder.path.toLowerCase() === needle
            || folder.displayName.toLowerCase() === needle,
        );
      }
      return undefined;
    };

    let folders = await imapRepository.listImapFolders(accountId);
    let target = matchFolder(folders);
    if (!target && profile) {
      const discovered = await imapTransport.discoverFolders(profile, secret);
      folders = await imapRepository.upsertImapFolders(accountId, sourceRefId, discovered, nowIso);
      target = matchFolder(folders);
    }
    return target;
  }

  public async applyFlagAction(
    messageId: string,
    flagName: MailMessageFlagName,
    enabled: boolean,
    nowIso: string,
  ): Promise<MailMessageLocalActionResult | undefined> {
    if (flagName === "important" || (flagName === "archived" && !enabled)) {
      return undefined;
    }
    const resolved = await this.resolveContextAndTransport(messageId, nowIso);
    if (!resolved) {
      return undefined;
    }
    const { context, imapRepository, imapTransport, account, secret } = resolved;

    if (flagName === "read" || flagName === "starred") {
      const remoteAtom = flagName === "read" ? "\\Seen" : "\\Flagged";
      await imapTransport.setMessageFlag(
        account.imap!,
        secret,
        context.folderPath,
        context.imapUid,
        remoteAtom,
        enabled,
      );
      const changed = await this.messageRepository.setMailMessageLocalFlag(
        messageId,
        flagName,
        enabled,
        nowIso,
      );
      if (changed === undefined) {
        throw new EasyEmailError("MAIL_MESSAGE_NOT_FOUND", `Mail message ${messageId} was not found.`);
      }
      return {
        messageId,
        changed,
        status: enabled ? `remote_${flagName}` : `remote_${flagName}_cleared`,
        remoteApplied: true,
      };
    }

    const targetFolder = await this.resolveTargetImapFolder(
      imapRepository,
      imapTransport,
      account.id,
      context.sourceRefId,
      account.imap,
      secret,
      { folderKind: "archive" },
      nowIso,
    );
    let remoteApplied = false;
    if (targetFolder && targetFolder.path !== context.folderPath) {
      const moved = await imapTransport.moveMessage(
        account.imap!,
        secret,
        context.folderPath,
        context.imapUid,
        targetFolder.path,
      );
      await imapRepository.updateImapMessageSourceFolderAndUid(
        context.sourceRowId,
        targetFolder.id,
        moved.targetUid,
        moved.targetUidValidity ?? targetFolder.uidValidity,
        nowIso,
      );
      remoteApplied = true;
    }

    const changed = await this.messageRepository.setMailMessageLocalFlag(
      messageId,
      "archived",
      true,
      nowIso,
    );
    if (changed === undefined) {
      throw new EasyEmailError("MAIL_MESSAGE_NOT_FOUND", `Mail message ${messageId} was not found.`);
    }
    return {
      messageId,
      changed,
      status: remoteApplied ? "remote_archived" : "archived",
      remoteApplied,
    };
  }

  public async applyFolderMoveAction(
    messageId: string,
    folderName: string,
    nowIso: string,
    options: { trashDeleteStatus?: boolean } = {},
  ): Promise<MailMessageLocalActionResult | undefined> {
    const resolved = await this.resolveContextAndTransport(messageId, nowIso);
    if (!resolved) {
      return undefined;
    }
    const { context, imapRepository, imapTransport, account, secret } = resolved;
    const remoteKind = remoteFolderKindForLocalFolder(folderName);
    const targetFolder = await this.resolveTargetImapFolder(
      imapRepository,
      imapTransport,
      account.id,
      context.sourceRefId,
      account.imap,
      secret,
      { folderKind: remoteKind, folderName },
      nowIso,
    );

    let remoteApplied = false;
    if (targetFolder && targetFolder.path !== context.folderPath) {
      const moved = await imapTransport.moveMessage(
        account.imap!,
        secret,
        context.folderPath,
        context.imapUid,
        targetFolder.path,
      );
      await imapRepository.updateImapMessageSourceFolderAndUid(
        context.sourceRowId,
        targetFolder.id,
        moved.targetUid,
        moved.targetUidValidity ?? targetFolder.uidValidity,
        nowIso,
      );
      remoteApplied = true;
    }

    const changed = await this.messageRepository.setMailMessageLocalFolder(
      messageId,
      folderName,
      nowIso,
    );
    if (changed === undefined) {
      throw new EasyEmailError("MAIL_MESSAGE_NOT_FOUND", `Mail message ${messageId} was not found.`);
    }
    const status = options.trashDeleteStatus
      ? remoteApplied
        ? "remote_deleted_to_trash"
        : "deleted_to_trash"
      : remoteApplied
        ? `remote_folder:${folderName}`
        : `folder:${folderName}`;
    return {
      messageId,
      changed,
      status,
      remoteApplied,
    };
  }

  public async applyPermanentDeleteAction(
    messageId: string,
    nowIso: string,
  ): Promise<MailMessageLocalActionResult | undefined> {
    const resolved = await this.resolveContextAndTransport(messageId, nowIso);
    if (!resolved) {
      return undefined;
    }
    const { context, imapTransport, account, secret } = resolved;
    await imapTransport.setMessageFlag(
      account.imap!,
      secret,
      context.folderPath,
      context.imapUid,
      "\\Deleted",
      true,
    );
    const changed = await this.messageRepository.softDeleteMailMessage(messageId, nowIso);
    if (changed === undefined) {
      throw new EasyEmailError("MAIL_MESSAGE_NOT_FOUND", `Mail message ${messageId} was not found.`);
    }
    return {
      messageId,
      changed,
      status: "remote_deleted_forever",
      remoteApplied: true,
    };
  }
}
