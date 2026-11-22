import type { MailAccountRepository } from "../domain/account.js";
import { EasyEmailError } from "../domain/errors.js";
import type {
  MailImapRepository,
  MailImapTransport,
} from "../domain/mail-imap-sync.js";
import type {
  MailDraftSaveInput,
  MailDraftSaveResult,
  MailMessageBatchActionResult,
  MailMessageDetail,
  MailMessageDetailScope,
  MailMessageListQuery,
  MailMessageListResult,
  MailMessageLocalActionResult,
  MailMessageRepository,
  MailMessageSetFlagInput,
  MailMessageSetFolderInput,
  MailMessageSetLabelInput,
  MailTrashEmptyInput,
} from "../domain/mail-message.js";
import type { MailCredentialResolver } from "./account-connectivity.js";
import type { EasyEmailService } from "./easy-email-service.js";
import { extractSnippetFromBodies, sanitizeMailHtml } from "./mail-html-sanitizer.js";
import { MailImapRemoteActions } from "./mail-imap-remote-actions.js";
import {
  ingestExternalMailMessage,
  ingestRuntimeObservedMessages,
  type ExternalMailMessageInput,
} from "./mail-message-ingestor.js";
import {
  assertKnownMailMessageFields,
  assertPlainObject,
  decodeMailMessageCursor,
  DEFAULT_MAIL_MESSAGE_PAGE_SIZE,
  DRAFT_SAVE_FIELDS,
  EMPTY_TRASH_FIELDS,
  encodeMailMessageCursor,
  MAX_MAIL_BODY_CHARS,
  MAX_MAIL_MESSAGE_PAGE_SIZE,
  normalizeDraftAddressList,
  normalizeMailFolderName,
  normalizeMailLabelName,
  normalizeMailMessageDetailScope,
  normalizeMailMessageFlagName,
  normalizeMailMessageId,
  normalizeMailMessageListScope,
  normalizeOptionalDraftText,
  normalizeRequiredBoolean,
  SET_FLAG_FIELDS,
  SET_FOLDER_FIELDS,
  SET_LABEL_FIELDS,
} from "./mail-message-validation.js";
import type { MailVerificationService } from "./mail-verifications.js";

export type { ExternalMailMessageInput } from "./mail-message-ingestor.js";

export interface MailMessageServiceDependencies {
  accountRepository?: MailAccountRepository;
  imapRepository?: MailImapRepository;
  credentialResolver?: MailCredentialResolver;
  imapTransport?: MailImapTransport;
  easyEmailService?: EasyEmailService;
  verificationService?: MailVerificationService;
}

export class MailMessageService {
  private readonly remoteActions: MailImapRemoteActions;

  public constructor(
    private readonly repository: MailMessageRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly dependencies: MailMessageServiceDependencies = {},
  ) {
    this.remoteActions = new MailImapRemoteActions(repository, {
      imapRepository: dependencies.imapRepository,
      accountRepository: dependencies.accountRepository,
      credentialResolver: dependencies.credentialResolver,
      imapTransport: dependencies.imapTransport,
      verificationService: dependencies.verificationService,
    });
  }

  public async ingestObservedMessages(): Promise<number> {
    return ingestRuntimeObservedMessages({
      repository: this.repository,
      easyEmailService: this.dependencies.easyEmailService,
      verificationService: this.dependencies.verificationService,
      nowIso: this.now().toISOString(),
    });
  }

  public async ingestExternalMessage(input: ExternalMailMessageInput): Promise<{ messageId: string }> {
    return ingestExternalMailMessage({
      repository: this.repository,
      verificationService: this.dependencies.verificationService,
      input,
      nowIso: this.now().toISOString(),
    });
  }

  private async assertScopedAccountAccess(
    scope: "normal_account" | "promoted_account" | "agent_account",
    accountId: string | undefined,
  ): Promise<string> {
    const normalizedAccountId = accountId?.trim() ?? "";
    if (!normalizedAccountId) {
      throw new EasyEmailError("INVALID_QUERY", `accountId is required for scope ${scope}.`);
    }
    if (!this.dependencies.accountRepository) {
      return normalizedAccountId;
    }
    const account = await this.dependencies.accountRepository.getMailAccount(normalizedAccountId);
    if (!account) {
      throw new EasyEmailError("ACCOUNT_NOT_FOUND", `Account ${normalizedAccountId} was not found.`);
    }
    if (scope === "agent_account" && account.scope !== "agent") {
      throw new EasyEmailError(
        "MAIL_MESSAGE_SCOPE_UNSUPPORTED",
        "Account does not belong to the agent scope.",
      );
    }
    if (scope !== "agent_account" && account.scope !== "normal") {
      throw new EasyEmailError(
        "MAIL_MESSAGE_SCOPE_UNSUPPORTED",
        "Account does not belong to the normal mail scope.",
      );
    }
    return account.id;
  }

  public async listMessages(query: MailMessageListQuery = {}): Promise<MailMessageListResult> {
    const scope = normalizeMailMessageListScope(query.scope);
    const limit = query.limit ?? DEFAULT_MAIL_MESSAGE_PAGE_SIZE;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_MAIL_MESSAGE_PAGE_SIZE) {
      throw new EasyEmailError(
        "INVALID_QUERY",
        `Mail message limit must be an integer from 1 to ${MAX_MAIL_MESSAGE_PAGE_SIZE}.`,
      );
    }

    const accountId =
      scope === "normal_account" || scope === "promoted_account" || scope === "agent_account"
        ? await this.assertScopedAccountAccess(scope, query.accountId)
        : query.accountId?.trim() || undefined;
    const sessionId = query.sessionId?.trim() || undefined;
    const folder = query.folder?.trim().toLowerCase() || undefined;
    const label = query.label?.trim().toLowerCase() || undefined;
    const search = query.search?.trim() || undefined;
    const includeArchived = query.includeArchived ?? true;

    const cursorBinding = {
      scope,
      accountId: accountId ?? null,
      sessionId: sessionId ?? null,
      folder: folder ?? null,
      label: label ?? null,
      search: search ?? null,
      includeArchived,
    };

    const after = query.cursor ? decodeMailMessageCursor(query.cursor, cursorBinding) : undefined;

    if (scope === "all" || scope === "anonymous" || scope === "promoted_account") {
      await this.ingestObservedMessages();
    }

    const result = await this.repository.listMailMessages({
      scope,
      accountId,
      sessionId,
      folder,
      label,
      search,
      includeArchived,
      limit,
      after,
    });
    const last = result.messages.at(-1);
    return {
      messages: result.messages,
      nextCursor: result.hasMore && last ? encodeMailMessageCursor(last, cursorBinding) : undefined,
    };
  }

  public async getMessageDetail(
    id: string,
    options: { scope?: MailMessageDetailScope; includeRawHtml?: boolean } = {},
  ): Promise<MailMessageDetail> {
    const normalizedId = normalizeMailMessageId(id);
    const scope = normalizeMailMessageDetailScope(options.scope);
    await this.ingestObservedMessages();
    await this.remoteActions.hydrateMessageBodyIfNeeded(normalizedId, this.now().toISOString());

    const found = await this.repository.getMailMessageDetail(normalizedId, scope);
    if (!found) {
      throw new EasyEmailError("MAIL_MESSAGE_NOT_FOUND", `Mail message ${normalizedId} was not found.`);
    }
    if (options.includeRawHtml && found.rawBodyHtml !== undefined) {
      return {
        ...found.detail,
        rawBodyHtml: found.rawBodyHtml,
      };
    }
    return found.detail;
  }

  public async saveLocalDraft(input: MailDraftSaveInput): Promise<MailDraftSaveResult> {
    assertPlainObject(input, "Draft save");
    assertKnownMailMessageFields(input, DRAFT_SAVE_FIELDS, "draft");
    const accountId = normalizeMailMessageId(input.accountId, "accountId");
    if (!this.dependencies.accountRepository) {
      throw new EasyEmailError(
        "ACCOUNTS_PERSISTENCE_UNAVAILABLE",
        "Persistent accounts are not available in this runtime.",
      );
    }
    const account = await this.dependencies.accountRepository.getMailAccount(accountId);
    if (!account) {
      throw new EasyEmailError("ACCOUNT_NOT_FOUND", `Account ${accountId} was not found.`);
    }
    if (account.kind === "anonymous_virtual" || account.status === "disabled" || !account.primaryAddress) {
      throw new EasyEmailError(
        "MAIL_DRAFT_ACCOUNT_UNSUPPORTED",
        "This account cannot persist local outgoing drafts.",
      );
    }

    const draftId = input.draftId === undefined || input.draftId === null || input.draftId === ""
      ? undefined
      : normalizeMailMessageId(input.draftId, "draftId");
    const targetAddress = normalizeOptionalDraftText(input.targetAddress, "targetAddress", 2048).trim();
    const ccAddresses = normalizeDraftAddressList(input.ccAddresses, "ccAddresses");
    const bccAddresses = normalizeDraftAddressList(input.bccAddresses, "bccAddresses");
    const subject = normalizeOptionalDraftText(input.subject, "subject", 998).trim();
    const bodyText = normalizeOptionalDraftText(input.bodyText, "bodyText", MAX_MAIL_BODY_CHARS);
    const rawBodyHtml = normalizeOptionalDraftText(input.bodyHtml, "bodyHtml", MAX_MAIL_BODY_CHARS);
    const sanitizedBodyHtml = sanitizeMailHtml(rawBodyHtml);
    const snippet = extractSnippetFromBodies(bodyText, sanitizedBodyHtml, subject || "(no subject)");

    return this.repository.upsertLocalDraft({
      draftId,
      accountId: account.id,
      fromAddress: account.primaryAddress,
      fromName: account.displayName,
      providerLabel: account.providerLabel ?? "Manual IMAP",
      targetAddress,
      ccAddresses,
      bccAddresses,
      subject,
      snippet,
      bodyText,
      bodyHtml: sanitizedBodyHtml,
      now: this.now().toISOString(),
    });
  }

  public async deleteLocalDraft(id: string): Promise<MailMessageLocalActionResult> {
    const normalizedId = normalizeMailMessageId(id);
    const deleted = await this.repository.deleteLocalDraft(normalizedId, this.now().toISOString());
    if (!deleted) {
      throw new EasyEmailError("MAIL_MESSAGE_NOT_FOUND", `Draft ${normalizedId} was not found.`);
    }
    return {
      messageId: normalizedId,
      changed: true,
      status: "deleted",
      remoteApplied: false,
    };
  }

  public async setLocalFlag(
    id: string,
    input: MailMessageSetFlagInput,
  ): Promise<MailMessageLocalActionResult> {
    const normalizedId = normalizeMailMessageId(id);
    assertPlainObject(input, "Message flag");
    assertKnownMailMessageFields(input, SET_FLAG_FIELDS, "message flag");
    const flagName = normalizeMailMessageFlagName(input.flagName);
    const enabled = normalizeRequiredBoolean(input.enabled, "enabled");

    await this.ingestObservedMessages();
    const nowIso = this.now().toISOString();
    const remoteResult = await this.remoteActions.applyFlagAction(
      normalizedId,
      flagName,
      enabled,
      nowIso,
    );
    if (remoteResult) {
      return remoteResult;
    }
    const changed = await this.repository.setMailMessageLocalFlag(
      normalizedId,
      flagName,
      enabled,
      nowIso,
    );
    if (changed === undefined) {
      throw new EasyEmailError("MAIL_MESSAGE_NOT_FOUND", `Mail message ${normalizedId} was not found.`);
    }
    return {
      messageId: normalizedId,
      changed,
      status: enabled ? flagName : `${flagName}_cleared`,
      remoteApplied: false,
    };
  }

  public async setLocalFolder(
    id: string,
    input: MailMessageSetFolderInput,
  ): Promise<MailMessageLocalActionResult> {
    const normalizedId = normalizeMailMessageId(id);
    assertPlainObject(input, "Message folder");
    assertKnownMailMessageFields(input, SET_FOLDER_FIELDS, "message folder");
    const folderName = normalizeMailFolderName(input.folderName);

    await this.ingestObservedMessages();
    const nowIso = this.now().toISOString();
    const remoteResult = await this.remoteActions.applyFolderMoveAction(
      normalizedId,
      folderName,
      nowIso,
    );
    if (remoteResult) {
      return remoteResult;
    }
    const changed = await this.repository.setMailMessageLocalFolder(
      normalizedId,
      folderName,
      nowIso,
    );
    if (changed === undefined) {
      throw new EasyEmailError("MAIL_MESSAGE_NOT_FOUND", `Mail message ${normalizedId} was not found.`);
    }
    return {
      messageId: normalizedId,
      changed,
      status: `folder:${folderName}`,
      remoteApplied: false,
    };
  }

  public async setLocalLabel(
    id: string,
    input: MailMessageSetLabelInput,
  ): Promise<MailMessageLocalActionResult> {
    const normalizedId = normalizeMailMessageId(id);
    assertPlainObject(input, "Message label");
    assertKnownMailMessageFields(input, SET_LABEL_FIELDS, "message label");
    const labelName = normalizeMailLabelName(input.labelName);
    const enabled = normalizeRequiredBoolean(input.enabled, "enabled");

    await this.ingestObservedMessages();
    const changed = await this.repository.setMailMessageLocalLabel(
      normalizedId,
      labelName,
      enabled,
      this.now().toISOString(),
    );
    if (changed === undefined) {
      throw new EasyEmailError("MAIL_MESSAGE_NOT_FOUND", `Mail message ${normalizedId} was not found.`);
    }
    return {
      messageId: normalizedId,
      changed,
      status: enabled ? `label:${labelName}` : `label_removed:${labelName}`,
      remoteApplied: false,
    };
  }

  public async deleteLocal(id: string): Promise<MailMessageLocalActionResult> {
    const normalizedId = normalizeMailMessageId(id);
    await this.ingestObservedMessages();
    const nowIso = this.now().toISOString();
    const remoteResult = await this.remoteActions.applyFolderMoveAction(
      normalizedId,
      "trash",
      nowIso,
      { trashDeleteStatus: true },
    );
    if (remoteResult) {
      return remoteResult;
    }
    const changed = await this.repository.setMailMessageLocalFolder(
      normalizedId,
      "trash",
      nowIso,
    );
    if (changed === undefined) {
      throw new EasyEmailError("MAIL_MESSAGE_NOT_FOUND", `Mail message ${normalizedId} was not found.`);
    }
    return {
      messageId: normalizedId,
      changed,
      status: "deleted_to_trash",
      remoteApplied: false,
    };
  }

  public async deleteForever(id: string): Promise<MailMessageLocalActionResult> {
    const normalizedId = normalizeMailMessageId(id);
    await this.ingestObservedMessages();
    const nowIso = this.now().toISOString();
    const remoteResult = await this.remoteActions.applyPermanentDeleteAction(normalizedId, nowIso);
    if (remoteResult) {
      return remoteResult;
    }
    const changed = await this.repository.softDeleteMailMessage(normalizedId, nowIso);
    if (changed === undefined) {
      throw new EasyEmailError("MAIL_MESSAGE_NOT_FOUND", `Mail message ${normalizedId} was not found.`);
    }
    return {
      messageId: normalizedId,
      changed,
      status: "deleted_forever",
      remoteApplied: false,
    };
  }

  public async emptyTrash(input: MailTrashEmptyInput = {}): Promise<MailMessageBatchActionResult> {
    assertPlainObject(input, "Empty trash");
    assertKnownMailMessageFields(input, EMPTY_TRASH_FIELDS, "empty trash");
    await this.ingestObservedMessages();

    let requestedIds: string[];
    if (input.messageIds !== undefined) {
      if (!Array.isArray(input.messageIds) || input.messageIds.length > 5000) {
        throw new EasyEmailError(
          "INVALID_MAIL_MESSAGE",
          "messageIds must be an array of at most 5000 message identifiers.",
        );
      }
      const seen = new Set<string>();
      requestedIds = [];
      for (const rawId of input.messageIds) {
        if (typeof rawId !== "string") {
          throw new EasyEmailError("INVALID_MAIL_MESSAGE", "messageIds entries must be strings.");
        }
        const trimmed = rawId.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        requestedIds.push(trimmed);
      }
    } else {
      requestedIds = await this.repository.listTrashMessageIds();
    }

    const nowIso = this.now().toISOString();
    let changedCount = 0;
    let remoteAppliedCount = 0;
    for (const messageId of requestedIds) {
      const remoteResult = await this.remoteActions.applyPermanentDeleteAction(messageId, nowIso);
      if (remoteResult) {
        if (remoteResult.changed) changedCount += 1;
        if (remoteResult.remoteApplied) remoteAppliedCount += 1;
        continue;
      }
      const deleted = await this.repository.softDeleteMailMessage(messageId, nowIso);
      if (deleted) {
        changedCount += 1;
      }
    }

    return {
      requestedCount: requestedIds.length,
      changedCount,
      remoteAppliedCount,
    };
  }

  public async promoteTemporarySessionMessages(
    sessionId: string,
    targetAccountId: string,
  ): Promise<{ linkedCount: number }> {
    const normalizedSessionId = normalizeMailMessageId(sessionId, "sessionId");
    const accountId = await this.assertScopedAccountAccess("normal_account", targetAccountId);
    await this.ingestObservedMessages();
    const linkedCount = await this.repository.promoteTemporarySessionMessages(
      normalizedSessionId,
      accountId,
      this.now().toISOString(),
    );
    return { linkedCount };
  }
}

export function createMailMessageService(
  repository: MailMessageRepository,
  now?: () => Date,
  dependencies?: MailMessageServiceDependencies,
): MailMessageService {
  return new MailMessageService(repository, now, dependencies);
}
