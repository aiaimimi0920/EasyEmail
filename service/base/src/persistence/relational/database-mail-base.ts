import { DatabaseSync } from "node:sqlite";

import type {
  MailImapFolder,
  MailImapFolderIngestInput,
  MailImapFolderIngestResult,
  MailImapMessageSourceContext,
  MailImapRemoteFolder,
  MailImapRepository,
  MailImapStoredCheckpoint,
} from "../../domain/mail-imap-sync.js";
import type {
  MailDraftRepositoryUpsertInput,
  MailDraftSaveResult,
  MailMessageClassification,
  MailMessageDetail,
  MailMessageDetailScope,
  MailMessageFlagName,
  MailMessageIngestInput,
  MailMessageIngestResult,
  MailMessageRepository,
  MailMessageRepositoryListQuery,
  MailMessageRepositoryListResult,
  MailVerificationListQuery,
  MailVerificationRecord,
  MailVerificationRepository,
  MailVerificationUpsertInput,
  StoredMessageVerificationSource,
} from "../../domain/mail-message.js";
import type {
  MailScheduledSendReopenResult,
  MailSendEnqueueResult,
  MailSendQueueClaimedPayload,
  MailSendQueueItem,
  MailSendQueueRepository,
  MailSendQueueRepositoryEnqueueInput,
  MailSendQueueRepositoryListQuery,
  MailSendQueueRepositoryListResult,
} from "../../domain/mail-send-queue.js";
import { SqliteMailImapRepository } from "./mail-imap-repository.js";
import { SqliteMailMessageRepository } from "./mail-message-repository.js";
import { SqliteMailSendQueueRepository } from "./mail-send-queue-repository.js";
import { SqliteMailVerificationRepository } from "./mail-verification-repository.js";

export abstract class SqliteMessageQueueImapDatabaseBase
  implements
    MailMessageRepository,
    MailVerificationRepository,
    MailSendQueueRepository,
    MailImapRepository
{
  protected readonly mailImap: SqliteMailImapRepository;
  protected readonly mailMessages: SqliteMailMessageRepository;
  protected readonly mailSendQueue: SqliteMailSendQueueRepository;
  protected readonly mailVerifications: SqliteMailVerificationRepository;

  protected constructor(protected readonly database: DatabaseSync) {
    this.mailImap = new SqliteMailImapRepository(database);
    this.mailMessages = new SqliteMailMessageRepository(database);
    this.mailSendQueue = new SqliteMailSendQueueRepository(database);
    this.mailVerifications = new SqliteMailVerificationRepository(database);
  }

  public upsertImapFolders(
    accountId: string,
    sourceRefId: string,
    folders: MailImapRemoteFolder[],
    now: string,
  ): Promise<MailImapFolder[]> {
    return this.mailImap.upsertImapFolders(accountId, sourceRefId, folders, now);
  }

  public listImapFolders(accountId: string): Promise<MailImapFolder[]> {
    return this.mailImap.listImapFolders(accountId);
  }

  public ingestImapFolderBatch(input: MailImapFolderIngestInput): Promise<MailImapFolderIngestResult> {
    return this.mailImap.ingestImapFolderBatch(input);
  }

  public getSyncCheckpoint(accountId: string): Promise<MailImapStoredCheckpoint | undefined> {
    return this.mailImap.getSyncCheckpoint(accountId);
  }

  public upsertSyncCheckpoint(input: MailImapStoredCheckpoint): Promise<void> {
    return this.mailImap.upsertSyncCheckpoint(input);
  }

  public getImapMessageSourceContext(messageId: string): Promise<MailImapMessageSourceContext | undefined> {
    return this.mailImap.getImapMessageSourceContext(messageId);
  }

  public cacheMailMessageBody(
    messageId: string,
    bodyText: string,
    bodyHtml: string | undefined,
    snippet: string,
    hasAttachments: boolean,
    now: string,
  ): Promise<void> {
    return this.mailImap.cacheMailMessageBody(
      messageId,
      bodyText,
      bodyHtml,
      snippet,
      hasAttachments,
      now,
    );
  }

  public updateImapMessageSourceFolderAndUid(
    sourceRowId: string,
    targetFolderId: string,
    targetUid: string | undefined,
    targetUidValidity: string | undefined,
    now: string,
  ): Promise<void> {
    return this.mailImap.updateImapMessageSourceFolderAndUid(
      sourceRowId,
      targetFolderId,
      targetUid,
      targetUidValidity,
      now,
    );
  }

  public ingestMailMessage(input: MailMessageIngestInput): Promise<MailMessageIngestResult> {
    return this.mailMessages.ingestMailMessage(input);
  }

  public listMailMessages(
    query: MailMessageRepositoryListQuery,
  ): Promise<MailMessageRepositoryListResult> {
    return this.mailMessages.listMailMessages(query);
  }

  public getMailMessageDetail(
    id: string,
    scope?: MailMessageDetailScope,
  ): Promise<{ detail: MailMessageDetail; rawBodyHtml?: string } | undefined> {
    return this.mailMessages.getMailMessageDetail(id, scope);
  }

  public upsertLocalDraft(input: MailDraftRepositoryUpsertInput): Promise<MailDraftSaveResult> {
    return this.mailMessages.upsertLocalDraft(input);
  }

  public deleteLocalDraft(id: string, now: string): Promise<boolean> {
    return this.mailMessages.deleteLocalDraft(id, now);
  }

  public setMailMessageLocalFlag(
    id: string,
    flagName: MailMessageFlagName,
    enabled: boolean,
    now: string,
  ): Promise<boolean | undefined> {
    return this.mailMessages.setMailMessageLocalFlag(id, flagName, enabled, now);
  }

  public setMailMessageLocalFolder(
    id: string,
    folderName: string,
    now: string,
  ): Promise<boolean | undefined> {
    return this.mailMessages.setMailMessageLocalFolder(id, folderName, now);
  }

  public setMailMessageLocalLabel(
    id: string,
    labelName: string,
    enabled: boolean,
    now: string,
  ): Promise<boolean | undefined> {
    return this.mailMessages.setMailMessageLocalLabel(id, labelName, enabled, now);
  }

  public softDeleteMailMessage(id: string, now: string): Promise<boolean | undefined> {
    return this.mailMessages.softDeleteMailMessage(id, now);
  }

  public listTrashMessageIds(): Promise<string[]> {
    return this.mailMessages.listTrashMessageIds();
  }

  public promoteTemporarySessionMessages(
    sessionId: string,
    targetAccountId: string,
    now: string,
  ): Promise<number> {
    return this.mailMessages.promoteTemporarySessionMessages(sessionId, targetAccountId, now);
  }

  public getMessageForVerification(id: string): Promise<StoredMessageVerificationSource | undefined> {
    return this.mailMessages.getMessageForVerification(id);
  }

  public setMailMessageClassification(
    id: string,
    classification: MailMessageClassification,
    now: string,
  ): Promise<void> {
    return this.mailMessages.setMailMessageClassification(id, classification, now);
  }

  public upsertMailVerificationCode(
    input: MailVerificationUpsertInput,
    nowMs: number,
  ): Promise<MailVerificationRecord> {
    return this.mailVerifications.upsertMailVerificationCode(input, nowMs);
  }

  public deleteMailVerificationCodesForMessage(messageId: string): Promise<number> {
    return this.mailVerifications.deleteMailVerificationCodesForMessage(messageId);
  }

  public listMailVerificationCodes(
    query: MailVerificationListQuery,
    nowMs: number,
  ): Promise<MailVerificationRecord[]> {
    return this.mailVerifications.listMailVerificationCodes(query, nowMs);
  }

  public enqueueOutgoingSend(input: MailSendQueueRepositoryEnqueueInput): Promise<MailSendEnqueueResult> {
    return this.mailSendQueue.enqueueOutgoingSend(input);
  }

  public listSendQueue(query: MailSendQueueRepositoryListQuery): Promise<MailSendQueueRepositoryListResult> {
    return this.mailSendQueue.listSendQueue(query);
  }

  public getSendQueueItem(id: string): Promise<MailSendQueueItem | undefined> {
    return this.mailSendQueue.getSendQueueItem(id);
  }

  public recoverStaleLeases(now: string): Promise<number> {
    return this.mailSendQueue.recoverStaleLeases(now);
  }

  public claimNextDueSend(
    leaseOwner: string,
    leaseExpiresAt: string,
    now: string,
  ): Promise<MailSendQueueClaimedPayload | undefined> {
    return this.mailSendQueue.claimNextDueSend(leaseOwner, leaseExpiresAt, now);
  }

  public claimNextDueScheduledSend(
    leaseOwner: string,
    leaseExpiresAt: string,
    now: string,
  ): Promise<MailSendQueueClaimedPayload | undefined> {
    return this.mailSendQueue.claimNextDueScheduledSend(leaseOwner, leaseExpiresAt, now);
  }

  public claimDueSendById(
    id: string,
    leaseOwner: string,
    leaseExpiresAt: string,
    now: string,
  ): Promise<MailSendQueueClaimedPayload | undefined> {
    return this.mailSendQueue.claimDueSendById(id, leaseOwner, leaseExpiresAt, now);
  }

  public completeClaimedSendSent(
    id: string,
    leaseOwner: string,
    providerMessageId: string | undefined,
    now: string,
  ): Promise<MailSendQueueItem | undefined> {
    return this.mailSendQueue.completeClaimedSendSent(id, leaseOwner, providerMessageId, now);
  }

  public completeClaimedSendRetry(
    id: string,
    leaseOwner: string,
    nextRetryAt: string,
    errorCode: string,
    errorMessage: string,
    now: string,
  ): Promise<MailSendQueueItem | undefined> {
    return this.mailSendQueue.completeClaimedSendRetry(
      id,
      leaseOwner,
      nextRetryAt,
      errorCode,
      errorMessage,
      now,
    );
  }

  public completeClaimedSendFailed(
    id: string,
    leaseOwner: string,
    terminalStatus: "failed" | "auth_failed",
    errorCode: string,
    errorMessage: string,
    now: string,
  ): Promise<MailSendQueueItem | undefined> {
    return this.mailSendQueue.completeClaimedSendFailed(
      id,
      leaseOwner,
      terminalStatus,
      errorCode,
      errorMessage,
      now,
    );
  }

  public cancelQueuedSend(
    id: string,
    expectedVersion: number | undefined,
    now: string,
  ): Promise<MailSendQueueItem | undefined> {
    return this.mailSendQueue.cancelQueuedSend(id, expectedVersion, now);
  }

  public retryTerminalSend(
    id: string,
    expectedVersion: number | undefined,
    allowDeliveryUnknown: boolean,
    now: string,
  ): Promise<MailSendQueueItem | undefined> {
    return this.mailSendQueue.retryTerminalSend(id, expectedVersion, allowDeliveryUnknown, now);
  }

  public reopenScheduledSendByMessageId(
    messageId: string,
    now: string,
  ): Promise<MailScheduledSendReopenResult> {
    return this.mailSendQueue.reopenScheduledSendByMessageId(messageId, now);
  }
}
