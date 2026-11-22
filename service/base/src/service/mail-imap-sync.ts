import type {
  MailAccount,
  MailAccountRepository,
  MailCredentialRef,
} from "../domain/account.js";
import { EasyEmailError } from "../domain/errors.js";
import type {
  MailAccountFolderSyncSummary,
  MailAccountSyncInput,
  MailAccountSyncResult,
  MailAccountSyncState,
  MailAccountSyncStatus,
  MailImapFolder,
  MailImapFolderKind,
  MailImapRepository,
  MailImapTransport,
} from "../domain/mail-imap-sync.js";
import type { MailCredentialResolver } from "./account-connectivity.js";
import type { MailVerificationService } from "./mail-verifications.js";

const DEFAULT_SYNC_LIMIT = 50;
const MAX_SYNC_LIMIT = 100;
const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1000;
const VALID_FOLDER_KINDS = new Set<MailImapFolderKind>([
  "inbox",
  "archive",
  "spam",
  "trash",
  "sent",
  "drafts",
  "mail",
]);

export interface MailAgentImapReplyAssociator {
  associateImapIncomingMessage(input: {
    accountId: string;
    messageId: string;
    fromAddress: string;
    subject: string;
    inReplyTo?: string;
    references: string[];
  }): Promise<unknown>;
}

export interface MailImapServiceDependencies {
  credentialResolver?: MailCredentialResolver;
  imapTransport?: MailImapTransport;
  verificationService?: MailVerificationService;
  agentReplyAssociator?: MailAgentImapReplyAssociator;
  staleAfterMs?: number;
}

export function selectAccountImapPasswordRef(account: MailAccount): MailCredentialRef {
  const candidates = account.credentialRefs.filter(
    (ref) => ref.credentialKind === "imap_password" && ref.authMethod === "password",
  );
  const selected =
    candidates.find((ref) => ref.status === "active")
    ?? candidates.find((ref) => ref.status === "missing");
  if (!selected) {
    throw new EasyEmailError(
      "ACCOUNT_REAUTH_REQUIRED",
      "Account has no active IMAP password credential reference.",
    );
  }
  return selected;
}

export async function resolveAccountImapSecret(options: {
  account: MailAccount;
  accountRepository: MailAccountRepository;
  credentialResolver?: MailCredentialResolver;
  useCase: "imap-sync" | "imap-action";
  nowIso: string;
}): Promise<{ credentialRef: MailCredentialRef; secret: string }> {
  const { account, accountRepository, credentialResolver, useCase, nowIso } = options;
  if (account.status === "disabled") {
    throw new EasyEmailError("ACCOUNT_DISABLED", "Account is disabled.");
  }
  if (!account.imap || account.kind === "anonymous_virtual") {
    throw new EasyEmailError(
      "ACCOUNT_IMAP_PROFILE_MISSING",
      "Account does not configure an IMAP profile.",
    );
  }
  if (!credentialResolver) {
    throw new EasyEmailError(
      "ACCOUNT_CREDENTIAL_UNAVAILABLE",
      "IMAP credential resolution is not configured in this runtime.",
    );
  }
  const credentialRef = selectAccountImapPasswordRef(account);
  const resolved = await credentialResolver.resolveCredential({
    account,
    credentialRef,
    useCase,
  });
  if (resolved.status === "missing") {
    await accountRepository.recordMailAccountReceiveOutcome?.({
      accountId: account.id,
      credentialRefId: credentialRef.id,
      receiveStatus: "auth_failed",
      authStatus: "reauthorization_required",
      credentialStatus: "missing",
      now: nowIso,
    });
    throw new EasyEmailError(
      "ACCOUNT_REAUTH_REQUIRED",
      "IMAP credential secret is missing from the local vault; reauthorization is required.",
    );
  }
  if (resolved.status === "unavailable") {
    throw new EasyEmailError(
      "ACCOUNT_CREDENTIAL_UNAVAILABLE",
      "IMAP credential vault is temporarily unavailable.",
    );
  }
  return { credentialRef, secret: resolved.secret };
}

function normalizeAccountId(raw: string): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed || trimmed.length > 256) {
    throw new EasyEmailError("INVALID_ACCOUNT", "Account id must be a non-empty string.");
  }
  return trimmed;
}

function normalizeSyncInput(input: MailAccountSyncInput): {
  limit: number;
  folderKinds: MailImapFolderKind[];
} {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new EasyEmailError("INVALID_QUERY", "Sync request body must be a JSON object.");
  }
  for (const key of Object.keys(input)) {
    if (key !== "limit" && key !== "folderKinds") {
      throw new EasyEmailError("INVALID_QUERY", `Unsupported sync field: ${key}.`);
    }
  }
  const limit = input.limit === undefined || input.limit === null
    ? DEFAULT_SYNC_LIMIT
    : input.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SYNC_LIMIT) {
    throw new EasyEmailError(
      "INVALID_QUERY",
      `Sync limit must be an integer from 1 to ${MAX_SYNC_LIMIT}.`,
    );
  }
  if (input.folderKinds === undefined) {
    return { limit, folderKinds: ["inbox", "spam"] };
  }
  if (!Array.isArray(input.folderKinds) || input.folderKinds.length === 0 || input.folderKinds.length > 10) {
    throw new EasyEmailError(
      "INVALID_QUERY",
      "folderKinds must be a non-empty array of supported IMAP folder kinds.",
    );
  }
  const seen = new Set<MailImapFolderKind>();
  for (const rawKind of input.folderKinds) {
    if (typeof rawKind !== "string" || !VALID_FOLDER_KINDS.has(rawKind as MailImapFolderKind)) {
      throw new EasyEmailError("INVALID_QUERY", `Unsupported folderKind: ${String(rawKind)}.`);
    }
    seen.add(rawKind as MailImapFolderKind);
  }
  return { limit, folderKinds: [...seen] };
}

export class MailImapService {
  private readonly staleAfterMs: number;

  public constructor(
    private readonly imapRepository: MailImapRepository,
    private readonly accountRepository: MailAccountRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly dependencies: MailImapServiceDependencies = {},
  ) {
    this.staleAfterMs = dependencies.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  }

  private async requireAccount(accountId: string): Promise<MailAccount> {
    const normalized = normalizeAccountId(accountId);
    const account = await this.accountRepository.getMailAccount(normalized);
    if (!account) {
      throw new EasyEmailError("ACCOUNT_NOT_FOUND", `Account ${normalized} was not found.`);
    }
    return account;
  }

  public async listFolders(
    accountId: string,
    options: { refresh?: boolean } = {},
  ): Promise<{ folders: MailImapFolder[]; refreshed: boolean }> {
    const account = await this.requireAccount(accountId);
    if (!account.imap || account.kind === "anonymous_virtual") {
      throw new EasyEmailError(
        "ACCOUNT_IMAP_PROFILE_MISSING",
        "Account does not configure an IMAP profile.",
      );
    }
    if (!options.refresh) {
      const folders = await this.imapRepository.listImapFolders(account.id);
      return { folders, refreshed: false };
    }
    if (!this.dependencies.imapTransport) {
      throw new EasyEmailError(
        "IMAP_UNAVAILABLE",
        "IMAP transport is not configured in this runtime.",
      );
    }
    const nowIso = this.now().toISOString();
    const { credentialRef, secret } = await resolveAccountImapSecret({
      account,
      accountRepository: this.accountRepository,
      credentialResolver: this.dependencies.credentialResolver,
      useCase: "imap-sync",
      nowIso,
    });

    try {
      const discovered = await this.dependencies.imapTransport.discoverFolders(account.imap, secret);
      const folders = await this.imapRepository.upsertImapFolders(
        account.id,
        `imap:${account.id}`,
        discovered,
        nowIso,
      );
      await this.accountRepository.recordMailAccountReceiveOutcome?.({
        accountId: account.id,
        credentialRefId: credentialRef.id,
        receiveStatus: "enabled",
        authStatus: "valid",
        credentialStatus: "active",
        verifiedAt: nowIso,
        now: nowIso,
      });
      return { folders, refreshed: true };
    } catch (error) {
      if (error instanceof EasyEmailError && error.code === "IMAP_AUTH_FAILED") {
        await this.accountRepository.recordMailAccountReceiveOutcome?.({
          accountId: account.id,
          credentialRefId: credentialRef.id,
          receiveStatus: "auth_failed",
          authStatus: "invalid",
          credentialStatus: "invalid",
          now: nowIso,
        });
      }
      throw error;
    }
  }

  public async getSyncStatus(accountId: string): Promise<MailAccountSyncStatus> {
    const account = await this.requireAccount(accountId);
    const [checkpoint, folders] = await Promise.all([
      this.imapRepository.getSyncCheckpoint(account.id),
      this.imapRepository.listImapFolders(account.id),
    ]);
    const nowMs = this.now().getTime();
    const lastSyncedMs = checkpoint?.lastSyncedAt ? Date.parse(checkpoint.lastSyncedAt) : Number.NaN;
    const ageStale = Number.isNaN(lastSyncedMs) || nowMs - lastSyncedMs > this.staleAfterMs;
    const failedLatestAttempt =
      checkpoint?.syncState === "error" || checkpoint?.syncState === "auth_failed";
    const isStale = ageStale || failedLatestAttempt;

    let syncState: MailAccountSyncState = "never_synced";
    if (checkpoint) {
      syncState = checkpoint.syncState === "synced" && isStale ? "stale" : checkpoint.syncState;
    }

    return {
      accountId: account.id,
      syncState,
      isStale,
      staleAfterMs: this.staleAfterMs,
      ...(checkpoint?.lastAttemptAt ? { lastAttemptAt: checkpoint.lastAttemptAt } : {}),
      ...(checkpoint?.lastSyncedAt ? { lastSyncedAt: checkpoint.lastSyncedAt } : {}),
      lastFetchedCount: checkpoint?.lastFetchedCount ?? 0,
      lastInsertedCount: checkpoint?.lastInsertedCount ?? 0,
      ...(checkpoint?.lastErrorCode ? { lastErrorCode: checkpoint.lastErrorCode } : {}),
      ...(checkpoint?.lastErrorMessage ? { lastErrorMessage: checkpoint.lastErrorMessage } : {}),
      folderCount: folders.length,
    };
  }

  public async syncAccount(
    accountId: string,
    input: MailAccountSyncInput = {},
  ): Promise<{ sync: MailAccountSyncResult; status: MailAccountSyncStatus }> {
    const { limit, folderKinds } = normalizeSyncInput(input);
    const account = await this.requireAccount(accountId);
    if (!this.dependencies.imapTransport) {
      throw new EasyEmailError(
        "IMAP_UNAVAILABLE",
        "IMAP transport is not configured in this runtime.",
      );
    }

    const attemptIso = this.now().toISOString();
    let fetchedCount = 0;
    let insertedCount = 0;
    let uidValidityChangedCount = 0;
    let resolvedRef: MailCredentialRef | undefined;

    try {
      const resolved = await resolveAccountImapSecret({
        account,
        accountRepository: this.accountRepository,
        credentialResolver: this.dependencies.credentialResolver,
        useCase: "imap-sync",
        nowIso: attemptIso,
      });
      resolvedRef = resolved.credentialRef;

      const sourceRefId = `imap:${account.id}`;
      const discovered = await this.dependencies.imapTransport.discoverFolders(
        account.imap!,
        resolved.secret,
      );
      const storedFolders = await this.imapRepository.upsertImapFolders(
        account.id,
        sourceRefId,
        discovered,
        attemptIso,
      );

      const primaryInbox =
        storedFolders.find((folder) => folder.folderKind === "inbox")
        ?? storedFolders[0];
      if (!primaryInbox) {
        throw new EasyEmailError("IMAP_INBOX_MISSING", "The IMAP server exposed no selectable folders.");
      }

      const requestedSet = new Set(folderKinds);
      const targetFolders = storedFolders.filter((folder) => requestedSet.has(folder.folderKind));
      if (targetFolders.length === 0) {
        targetFolders.push(primaryInbox);
      }

      const folderSummaries: MailAccountFolderSyncSummary[] = [];
      for (const folder of targetFolders) {
        const batch = await this.dependencies.imapTransport.syncFolderHeaders(
          account.imap!,
          resolved.secret,
          {
            folderPath: folder.path,
            knownUidValidity: folder.uidValidity,
            lastSeenUid: folder.lastSeenUid,
            limit,
          },
        );
        const nowIso = this.now().toISOString();
        const persisted = await this.imapRepository.ingestImapFolderBatch({
          accountId: account.id,
          sourceRefId,
          receivedAddress: account.primaryAddress ?? account.imap!.username,
          providerLabel: account.providerLabel ?? account.displayName,
          folder,
          batch,
          now: nowIso,
        });
        fetchedCount += persisted.fetchedCount;
        insertedCount += persisted.insertedCount;
        if (batch.uidValidityChanged) {
          uidValidityChangedCount += 1;
        }
        for (const messageId of persisted.insertedMessageIds) {
          await this.dependencies.verificationService?.classifyStoredMessage(messageId, {
            missingIsError: false,
          });
        }
        if (
          account.scope === "agent"
          && this.dependencies.agentReplyAssociator
          && folder.folderKind !== "sent"
          && folder.folderKind !== "drafts"
          && folder.folderKind !== "trash"
        ) {
          for (const entry of persisted.insertedMessages ?? []) {
            await this.dependencies.agentReplyAssociator.associateImapIncomingMessage({
              accountId: account.id,
              messageId: entry.messageId,
              fromAddress: entry.fromAddress,
              subject: entry.subject,
              inReplyTo: entry.inReplyTo,
              references: entry.references,
            });
          }
        }
        folderSummaries.push({
          folderId: folder.id,
          path: folder.path,
          folderKind: folder.folderKind,
          fetchedCount: persisted.fetchedCount,
          insertedCount: persisted.insertedCount,
          uidValidityChanged: batch.uidValidityChanged,
        });
      }

      const syncedAt = this.now().toISOString();
      await this.imapRepository.upsertSyncCheckpoint({
        accountId: account.id,
        syncState: "synced",
        lastAttemptAt: attemptIso,
        lastSyncedAt: syncedAt,
        lastFetchedCount: fetchedCount,
        lastInsertedCount: insertedCount,
        updatedAt: syncedAt,
      });
      await this.accountRepository.recordMailAccountReceiveOutcome?.({
        accountId: account.id,
        credentialRefId: resolvedRef.id,
        receiveStatus: "enabled",
        authStatus: "valid",
        credentialStatus: "active",
        verifiedAt: syncedAt,
        now: syncedAt,
      });

      return {
        sync: {
          accountId: account.id,
          primaryFolderId: primaryInbox.id,
          fetchedCount,
          insertedCount,
          uidValidityChangedCount,
          folders: folderSummaries,
          syncedAt,
        },
        status: await this.getSyncStatus(account.id),
      };
    } catch (error) {
      const failedAt = this.now().toISOString();
      const errorCode = error instanceof EasyEmailError ? error.code : "IMAP_SYNC_FAILED";
      const errorMessage = error instanceof Error ? error.message : "IMAP synchronization failed.";
      const isAuthFailure =
        errorCode === "IMAP_AUTH_FAILED" || errorCode === "ACCOUNT_REAUTH_REQUIRED";

      await this.imapRepository.upsertSyncCheckpoint({
        accountId: account.id,
        syncState: isAuthFailure ? "auth_failed" : "error",
        lastAttemptAt: attemptIso,
        lastFetchedCount: fetchedCount,
        lastInsertedCount: insertedCount,
        lastErrorCode: errorCode,
        lastErrorMessage: errorMessage,
        updatedAt: failedAt,
      });

      if (resolvedRef) {
        await this.accountRepository.recordMailAccountReceiveOutcome?.({
          accountId: account.id,
          credentialRefId: resolvedRef.id,
          receiveStatus: isAuthFailure ? "auth_failed" : "provider_unavailable",
          authStatus: errorCode === "IMAP_AUTH_FAILED" ? "invalid" : account.authStatus,
          credentialStatus: errorCode === "IMAP_AUTH_FAILED" ? "invalid" : resolvedRef.status,
          now: failedAt,
        });
      }
      throw error;
    }
  }
}

export function createMailImapService(
  imapRepository: MailImapRepository,
  accountRepository: MailAccountRepository,
  now?: () => Date,
  dependencies?: MailImapServiceDependencies,
): MailImapService {
  return new MailImapService(imapRepository, accountRepository, now, dependencies);
}
