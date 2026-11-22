import { randomUUID } from "node:crypto";

import type { MailAccount, MailAccountRepository, MailCredentialRef } from "../domain/account.js";
import { EasyEmailError } from "../domain/errors.js";
import type {
  MailScheduledSendReopenResult,
  MailSendEnqueueInput,
  MailSendEnqueueResult,
  MailSendQueueCancelInput,
  MailSendQueueClaimedPayload,
  MailSendQueueItem,
  MailSendQueueListQuery,
  MailSendQueueListResult,
  MailSendQueueRepository,
  MailSendQueueRetryInput,
  MailSendQueueRunBatchInput,
  MailSendQueueWorkerRunResult,
  MailSendQueueWorkerStatus,
} from "../domain/mail-send-queue.js";
import type {
  MailCredentialResolver,
  MailSmtpTransport,
} from "./account-connectivity.js";
import { assertNoRawSecretFields, assertOnlyKnownFields } from "./account-validation.js";
import { extractSnippetFromBodies, sanitizeMailHtml } from "./mail-html-sanitizer.js";
import { deliverClaimedSendPayload } from "./mail-send-queue-delivery.js";
import {
  DEFAULT_SEND_QUEUE_DUE_BATCH_LIMIT,
  DEFAULT_SEND_QUEUE_PAGE_SIZE,
  MAX_SEND_QUEUE_DUE_BATCH_LIMIT,
  MAX_SEND_QUEUE_PAGE_SIZE,
  SEND_CANCEL_FIELDS,
  SEND_RETRY_FIELDS,
  SEND_RUN_BATCH_FIELDS,
  decodeSendQueueCursor,
  encodeSendQueueCursor,
  normalizeEnqueueInput,
  normalizeSendQueueStatus,
} from "./mail-send-queue-validation.js";

const DEFAULT_LEASE_DURATION_MS = 15 * 60 * 1000;
const DEFAULT_WORKER_INTERVAL_MS = 15_000;

export interface MailSendQueueServiceDependencies {
  accountRepository?: MailAccountRepository;
  credentialResolver?: MailCredentialResolver;
  smtpTransport?: MailSmtpTransport;
  leaseDurationMs?: number;
  workerIntervalMs?: number;
  workerEnabled?: boolean;
}

function selectSendCredentialRef(account: MailAccount): MailCredentialRef | undefined {
  const candidates = account.credentialRefs.filter(
    (ref) =>
      ref.ownerAccountId === account.id
      && ref.credentialKind === "smtp_password"
      && ref.authMethod === "password"
      && ref.status !== "disabled"
      && ref.status !== "invalid",
  );
  return candidates.find((ref) => ref.status === "active") ?? candidates[0];
}

export class MailSendQueueService {
  private readonly leaseDurationMs: number;
  private workerEnabled: boolean;
  private workerIntervalMs: number;
  private workerRunning = false;
  private lastRunAt?: string;
  private lastResult?: MailSendQueueWorkerRunResult;
  private totalProcessedCount = 0;
  private totalSentCount = 0;
  private totalRetryCount = 0;
  private totalFailedCount = 0;
  private lastErrorMessage?: string;

  public constructor(
    private readonly repository: MailSendQueueRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly dependencies: MailSendQueueServiceDependencies = {},
  ) {
    this.leaseDurationMs = dependencies.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.workerIntervalMs = dependencies.workerIntervalMs ?? DEFAULT_WORKER_INTERVAL_MS;
    this.workerEnabled = dependencies.workerEnabled ?? false;
  }

  public setWorkerLoopState(enabled: boolean, intervalMs?: number): void {
    this.workerEnabled = enabled;
    if (intervalMs !== undefined) {
      this.workerIntervalMs = intervalMs;
    }
  }

  public getWorkerStatus(): MailSendQueueWorkerStatus {
    return {
      enabled: this.workerEnabled,
      running: this.workerRunning,
      intervalMs: this.workerIntervalMs,
      leaseDurationMs: this.leaseDurationMs,
      ...(this.lastRunAt ? { lastRunAt: this.lastRunAt } : {}),
      ...(this.lastResult ? { lastResult: this.lastResult } : {}),
      totalProcessedCount: this.totalProcessedCount,
      totalSentCount: this.totalSentCount,
      totalRetryCount: this.totalRetryCount,
      totalFailedCount: this.totalFailedCount,
      ...(this.lastErrorMessage ? { lastErrorMessage: this.lastErrorMessage } : {}),
    };
  }

  private requireAccountRepository(): MailAccountRepository {
    if (!this.dependencies.accountRepository) {
      throw new EasyEmailError(
        "ACCOUNTS_PERSISTENCE_UNAVAILABLE",
        "Persistent accounts are not available in this runtime.",
      );
    }
    return this.dependencies.accountRepository;
  }

  public async enqueueSend(
    input: MailSendEnqueueInput,
    headerIdempotencyKey?: string,
  ): Promise<MailSendEnqueueResult> {
    const normalized = normalizeEnqueueInput(input, headerIdempotencyKey);
    const account = await this.requireAccountRepository().getMailAccount(normalized.accountId);
    if (!account) {
      throw new EasyEmailError("ACCOUNT_NOT_FOUND", `Account ${normalized.accountId} was not found.`);
    }
    if (account.kind === "anonymous_virtual" || account.scope === "system") {
      throw new EasyEmailError("ANONYMOUS_ACCOUNT_CANNOT_SEND", "Anonymous virtual mailboxes cannot send mail.");
    }
    if (account.status === "disabled" || account.sendStatus !== "enabled") {
      throw new EasyEmailError("ACCOUNT_SEND_NOT_ENABLED", "This account is not enabled for sending.");
    }
    if (!account.smtp || !account.primaryAddress) {
      throw new EasyEmailError("ACCOUNT_SMTP_CONFIG_REQUIRED", "This account does not have an SMTP sending profile.");
    }
    const credentialRef = selectSendCredentialRef(account);
    if (!credentialRef) {
      throw new EasyEmailError(
        "ACCOUNT_REAUTHENTICATION_REQUIRED",
        "The account SMTP credential must be configured before sending.",
      );
    }

    const sanitizedHtml = normalized.bodyHtml ? sanitizeMailHtml(normalized.bodyHtml) : undefined;
    const snippet = extractSnippetFromBodies(normalized.bodyText, sanitizedHtml, normalized.subject);
    const now = this.now().toISOString();

    return this.repository.enqueueOutgoingSend({
      accountId: account.id,
      accountScope: account.scope,
      providerLabel: account.providerLabel ?? account.displayName,
      senderAddress: account.primaryAddress,
      senderName: account.displayName,
      smtpHost: account.smtp.host,
      smtpPort: account.smtp.port,
      smtpSecurity: account.smtp.security,
      smtpUsername: account.smtp.username,
      credentialRefId: credentialRef.id,
      targetAddress: normalized.targetAddress,
      ccAddresses: normalized.ccAddresses,
      bccAddresses: normalized.bccAddresses,
      scheduledAt: normalized.scheduledAt,
      subject: normalized.subject,
      snippet,
      bodyText: normalized.bodyText,
      bodyHtml: sanitizedHtml,
      idempotencyKey: normalized.idempotencyKey,
      payloadFingerprint: normalized.payloadFingerprint,
      now,
    });
  }

  public async listSendQueue(query: MailSendQueueListQuery = {}): Promise<MailSendQueueListResult> {
    const accountId = query.accountId?.trim() || undefined;
    const status = query.status === undefined ? undefined : normalizeSendQueueStatus(query.status);
    const limit = query.limit ?? DEFAULT_SEND_QUEUE_PAGE_SIZE;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SEND_QUEUE_PAGE_SIZE) {
      throw new EasyEmailError("INVALID_QUERY", `Send queue limit must be 1..${MAX_SEND_QUEUE_PAGE_SIZE}.`);
    }
    const result = await this.repository.listSendQueue({
      accountId,
      status,
      limit,
      after: query.cursor ? decodeSendQueueCursor(query.cursor, accountId, status) : undefined,
    });
    const last = result.items.at(-1);
    return {
      items: result.items,
      nextCursor: result.hasMore && last ? encodeSendQueueCursor(last, accountId, status) : undefined,
      worker: this.getWorkerStatus(),
    };
  }

  public async getSendQueueItem(id: string): Promise<MailSendQueueItem> {
    const trimmed = id.trim();
    const item = trimmed ? await this.repository.getSendQueueItem(trimmed) : undefined;
    if (!item) {
      throw new EasyEmailError("SEND_QUEUE_ITEM_NOT_FOUND", `Send queue item ${id} was not found.`);
    }
    return item;
  }

  public async cancelSendQueueItem(
    id: string,
    input: MailSendQueueCancelInput = {},
  ): Promise<MailSendQueueItem> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new EasyEmailError("INVALID_SEND_MESSAGE", "Cancel request must be an object.");
    }
    assertNoRawSecretFields(input);
    assertOnlyKnownFields(input as Record<string, unknown>, SEND_CANCEL_FIELDS, "Cancel request");
    if (
      input.expectedVersion !== undefined
      && (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
    ) {
      throw new EasyEmailError("INVALID_SEND_MESSAGE", "expectedVersion must be a positive integer.");
    }
    const updated = await this.repository.cancelQueuedSend(id.trim(), input.expectedVersion, this.now().toISOString());
    if (!updated) {
      throw new EasyEmailError("SEND_QUEUE_ITEM_NOT_FOUND", `Send queue item ${id} was not found.`);
    }
    return updated;
  }

  public async retrySendQueueItem(
    id: string,
    input: MailSendQueueRetryInput = {},
  ): Promise<MailSendQueueItem> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new EasyEmailError("INVALID_SEND_MESSAGE", "Retry request must be an object.");
    }
    assertNoRawSecretFields(input);
    assertOnlyKnownFields(input as Record<string, unknown>, SEND_RETRY_FIELDS, "Retry request");
    if (
      input.expectedVersion !== undefined
      && (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
    ) {
      throw new EasyEmailError("INVALID_SEND_MESSAGE", "expectedVersion must be a positive integer.");
    }
    const updated = await this.repository.retryTerminalSend(
      id.trim(),
      input.expectedVersion,
      input.confirmDeliveryUnknown === true,
      this.now().toISOString(),
    );
    if (!updated) {
      throw new EasyEmailError("SEND_QUEUE_ITEM_NOT_FOUND", `Send queue item ${id} was not found.`);
    }
    return updated;
  }

  public async reopenScheduledSend(messageId: string): Promise<MailScheduledSendReopenResult> {
    const trimmed = messageId.trim();
    if (!trimmed) {
      throw new EasyEmailError("MAIL_MESSAGE_NOT_FOUND", "messageId is required.");
    }
    return this.repository.reopenScheduledSendByMessageId(trimmed, this.now().toISOString());
  }

  public async runOnce(): Promise<MailSendQueueWorkerRunResult> {
    return this.executeWorkerStep(async (leaseOwner, leaseExpiresAt, nowIso) => {
      const claimed = await this.repository.claimNextDueSend(leaseOwner, leaseExpiresAt, nowIso);
      if (!claimed) {
        return { processedCount: 0, sentCount: 0, retryCount: 0, failedCount: 0 };
      }
      return this.deliverClaimed(claimed, leaseOwner);
    });
  }

  public async runItem(queueItemId: string): Promise<{
    queueItem: MailSendQueueItem;
    runResult: MailSendQueueWorkerRunResult;
  }> {
    const trimmed = queueItemId.trim();
    await this.getSendQueueItem(trimmed);
    const runResult = await this.executeWorkerStep(async (leaseOwner, leaseExpiresAt, nowIso) => {
      const claimed = await this.repository.claimDueSendById(trimmed, leaseOwner, leaseExpiresAt, nowIso);
      if (!claimed) {
        return { processedCount: 0, sentCount: 0, retryCount: 0, failedCount: 0 };
      }
      return this.deliverClaimed(claimed, leaseOwner);
    });
    const queueItem = await this.getSendQueueItem(trimmed);
    return { queueItem, runResult };
  }

  public async runDueBatch(input: MailSendQueueRunBatchInput = {}): Promise<MailSendQueueWorkerRunResult> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new EasyEmailError("INVALID_SEND_MESSAGE", "Run due batch request must be an object.");
    }
    assertNoRawSecretFields(input);
    assertOnlyKnownFields(input as Record<string, unknown>, SEND_RUN_BATCH_FIELDS, "Run due batch");
    const rawLimit = input.limit ?? DEFAULT_SEND_QUEUE_DUE_BATCH_LIMIT;
    if (!Number.isSafeInteger(rawLimit) || rawLimit < 1) {
      throw new EasyEmailError("INVALID_QUERY", "limit must be a positive integer.");
    }
    const clampedLimit = Math.min(MAX_SEND_QUEUE_DUE_BATCH_LIMIT, rawLimit);

    return this.executeWorkerStep(async () => {
      const batchTotal: MailSendQueueWorkerRunResult = {
        processedCount: 0,
        sentCount: 0,
        retryCount: 0,
        failedCount: 0,
      };
      for (let index = 0; index < clampedLimit; index += 1) {
        const stepNow = this.now();
        const leaseOwner = `worker_${randomUUID()}`;
        const leaseExpiresAt = new Date(stepNow.getTime() + this.leaseDurationMs).toISOString();
        const claimed = await this.repository.claimNextDueSend(
          leaseOwner,
          leaseExpiresAt,
          stepNow.toISOString(),
        );
        if (!claimed) break;
        const single = await this.deliverClaimed(claimed, leaseOwner);
        batchTotal.processedCount += single.processedCount;
        batchTotal.sentCount += single.sentCount;
        batchTotal.retryCount += single.retryCount;
        batchTotal.failedCount += single.failedCount;
      }
      return batchTotal;
    });
  }

  private deliverClaimed(
    claimed: MailSendQueueClaimedPayload,
    leaseOwner: string,
  ): Promise<MailSendQueueWorkerRunResult> {
    return deliverClaimedSendPayload(
      {
        repository: this.repository,
        accountRepository: this.requireAccountRepository(),
        credentialResolver: this.dependencies.credentialResolver,
        smtpTransport: this.dependencies.smtpTransport,
        now: this.now,
      },
      claimed,
      leaseOwner,
    );
  }

  private async executeWorkerStep(
    runner: (
      leaseOwner: string,
      leaseExpiresAt: string,
      nowIso: string,
    ) => Promise<MailSendQueueWorkerRunResult>,
  ): Promise<MailSendQueueWorkerRunResult> {
    this.workerRunning = true;
    const startedAt = this.now();
    const nowIso = startedAt.toISOString();
    try {
      const recovered = await this.repository.recoverStaleLeases(nowIso);
      const leaseOwner = `worker_${randomUUID()}`;
      const leaseExpiresAt = new Date(startedAt.getTime() + this.leaseDurationMs).toISOString();
      const stepResult = await runner(leaseOwner, leaseExpiresAt, nowIso);
      const combined: MailSendQueueWorkerRunResult = {
        processedCount: recovered + stepResult.processedCount,
        sentCount: stepResult.sentCount,
        retryCount: stepResult.retryCount,
        failedCount: recovered + stepResult.failedCount,
      };
      this.lastRunAt = this.now().toISOString();
      this.lastResult = combined;
      this.totalProcessedCount += combined.processedCount;
      this.totalSentCount += combined.sentCount;
      this.totalRetryCount += combined.retryCount;
      this.totalFailedCount += combined.failedCount;
      this.lastErrorMessage = undefined;
      return combined;
    } catch (error) {
      this.lastErrorMessage = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.workerRunning = false;
    }
  }
}

export function createMailSendQueueService(
  repository: MailSendQueueRepository,
  now?: () => Date,
  dependencies?: MailSendQueueServiceDependencies,
): MailSendQueueService {
  return new MailSendQueueService(repository, now, dependencies);
}
