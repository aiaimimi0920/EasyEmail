import type { MailAccountRepository } from "../domain/account.js";
import { EasyEmailError } from "../domain/errors.js";
import type {
  MailSendQueueClaimedPayload,
  MailSendQueueRepository,
  MailSendQueueWorkerRunResult,
} from "../domain/mail-send-queue.js";
import type {
  MailCredentialResolver,
  MailSmtpTransport,
} from "./account-connectivity.js";

const BASE_BACKOFF_SECONDS = 60;
const MAX_BACKOFF_SECONDS = 3_600;
const MAX_SEND_ATTEMPTS = 5;

export function computeSendQueueNextRetryAt(
  now: Date,
  attemptCountBeforeFailure: number,
): string {
  const exponent = Math.max(0, Math.min(8, attemptCountBeforeFailure));
  const backoffSeconds = Math.min(MAX_BACKOFF_SECONDS, BASE_BACKOFF_SECONDS * (2 ** exponent));
  return new Date(now.getTime() + backoffSeconds * 1000).toISOString();
}

export interface DeliverClaimedSendContext {
  repository: MailSendQueueRepository;
  accountRepository: MailAccountRepository;
  credentialResolver?: MailCredentialResolver;
  smtpTransport?: MailSmtpTransport;
  now: () => Date;
}

export async function deliverClaimedSendPayload(
  context: DeliverClaimedSendContext,
  claimed: MailSendQueueClaimedPayload,
  leaseOwner: string,
): Promise<MailSendQueueWorkerRunResult> {
  const { repository, accountRepository, credentialResolver, smtpTransport, now } = context;
  const { queueItem } = claimed;

  const account = await accountRepository.getMailAccount(queueItem.accountId);
  const credentialRef = account?.credentialRefs.find((ref) => ref.id === queueItem.credentialRefId);
  if (!account || account.status === "disabled" || !credentialRef || credentialRef.status === "disabled") {
    const updated = await repository.completeClaimedSendFailed(
      queueItem.id,
      leaseOwner,
      "failed",
      "ACCOUNT_SEND_NOT_ENABLED",
      "The sender account or credential reference is no longer available.",
      now().toISOString(),
    );
    if (!updated) throw new EasyEmailError("SEND_QUEUE_LEASE_LOST", "Send queue lease expired during processing.");
    return { processedCount: 1, sentCount: 0, retryCount: 0, failedCount: 1 };
  }

  if (!credentialResolver || !smtpTransport) {
    const currentNow = now();
    const retryTime = computeSendQueueNextRetryAt(currentNow, queueItem.attemptCount);
    const updated = await repository.completeClaimedSendRetry(
      queueItem.id,
      leaseOwner,
      retryTime,
      !credentialResolver ? "ACCOUNT_CREDENTIAL_UNAVAILABLE" : "SMTP_TRANSPORT_UNAVAILABLE",
      !credentialResolver
        ? "The credential resolver is temporarily unavailable."
        : "The SMTP transport is unavailable in this runtime.",
      currentNow.toISOString(),
    );
    if (!updated) throw new EasyEmailError("SEND_QUEUE_LEASE_LOST", "Send queue lease expired during processing.");
    return { processedCount: 1, sentCount: 0, retryCount: 1, failedCount: 0 };
  }

  let resolution;
  try {
    resolution = await credentialResolver.resolveCredential({
      account,
      credentialRef,
      useCase: "smtp-send",
    });
  } catch {
    resolution = { status: "unavailable" as const };
  }

  if (resolution.status === "missing") {
    const nowIso = now().toISOString();
    await accountRepository.recordMailAccountSendOutcome?.({
      accountId: account.id,
      credentialRefId: credentialRef.id,
      sendStatus: "auth_failed",
      credentialStatus: "missing",
      now: nowIso,
    });
    const updated = await repository.completeClaimedSendFailed(
      queueItem.id,
      leaseOwner,
      "auth_failed",
      "ACCOUNT_REAUTHENTICATION_REQUIRED",
      "The account SMTP credential is missing and must be provided again.",
      nowIso,
    );
    if (!updated) throw new EasyEmailError("SEND_QUEUE_LEASE_LOST", "Send queue lease expired during processing.");
    return { processedCount: 1, sentCount: 0, retryCount: 0, failedCount: 1 };
  }

  if (resolution.status !== "resolved" || !resolution.secret) {
    const nowDate = now();
    const retryTime = computeSendQueueNextRetryAt(nowDate, queueItem.attemptCount);
    const updated = await repository.completeClaimedSendRetry(
      queueItem.id,
      leaseOwner,
      retryTime,
      "ACCOUNT_CREDENTIAL_UNAVAILABLE",
      "The credential broker could not be reached; queued for retry.",
      nowDate.toISOString(),
    );
    if (!updated) throw new EasyEmailError("SEND_QUEUE_LEASE_LOST", "Send queue lease expired during processing.");
    return { processedCount: 1, sentCount: 0, retryCount: 1, failedCount: 0 };
  }

  try {
    const delivery = await smtpTransport.sendMessage(
      {
        protocol: "smtp",
        host: queueItem.smtpHost,
        port: queueItem.smtpPort,
        security: queueItem.smtpSecurity,
        username: queueItem.smtpUsername,
      },
      resolution.secret,
      {
        fromAddress: queueItem.senderAddress,
        fromName: account.displayName,
        toAddresses: queueItem.targetAddress.split(",").map((s) => s.trim()).filter(Boolean),
        ccAddresses: queueItem.ccAddresses,
        bccAddresses: queueItem.bccAddresses,
        subject: queueItem.subject,
        bodyText: claimed.bodyText,
        bodyHtml: claimed.bodyHtml,
      },
    );
    const sentNow = now().toISOString();
    const updated = await repository.completeClaimedSendSent(
      queueItem.id,
      leaseOwner,
      delivery.providerMessageId,
      sentNow,
    );
    if (!updated) {
      throw new EasyEmailError("SEND_QUEUE_LEASE_LOST", "Send queue lease expired during delivery.");
    }
    await accountRepository.recordMailAccountSendOutcome?.({
      accountId: account.id,
      credentialRefId: credentialRef.id,
      sendStatus: "enabled",
      credentialStatus: "active",
      verifiedAt: sentNow,
      now: sentNow,
    });
    return { processedCount: 1, sentCount: 1, retryCount: 0, failedCount: 0 };
  } catch (error) {
    if (error instanceof EasyEmailError && error.code === "SEND_QUEUE_LEASE_LOST") {
      throw error;
    }
    const failedAt = now();
    const failedIso = failedAt.toISOString();
    const errorCode = error instanceof EasyEmailError ? error.code : "SMTP_TRANSIENT_ERROR";
    const rawMessage = error instanceof Error ? error.message : "SMTP delivery failed.";
    const safeMessage = rawMessage.split(resolution.secret).join("[redacted]").slice(0, 512);

    if (errorCode === "SMTP_AUTH_FAILED") {
      await accountRepository.recordMailAccountSendOutcome?.({
        accountId: account.id,
        credentialRefId: credentialRef.id,
        sendStatus: "auth_failed",
        credentialStatus: "invalid",
        now: failedIso,
      });
      const updated = await repository.completeClaimedSendFailed(
        queueItem.id,
        leaseOwner,
        "auth_failed",
        errorCode,
        safeMessage,
        failedIso,
      );
      if (!updated) throw new EasyEmailError("SEND_QUEUE_LEASE_LOST", "Send queue lease expired during processing.");
      return { processedCount: 1, sentCount: 0, retryCount: 0, failedCount: 1 };
    }

    const isRetryable = errorCode === "SMTP_TRANSIENT_ERROR" || errorCode === "SMTP_TIMEOUT";
    if (isRetryable && queueItem.attemptCount + 1 < MAX_SEND_ATTEMPTS) {
      const nextRetryAt = computeSendQueueNextRetryAt(failedAt, queueItem.attemptCount);
      const updated = await repository.completeClaimedSendRetry(
        queueItem.id,
        leaseOwner,
        nextRetryAt,
        errorCode,
        safeMessage,
        failedIso,
      );
      if (!updated) throw new EasyEmailError("SEND_QUEUE_LEASE_LOST", "Send queue lease expired during processing.");
      return { processedCount: 1, sentCount: 0, retryCount: 1, failedCount: 0 };
    }

    const updated = await repository.completeClaimedSendFailed(
      queueItem.id,
      leaseOwner,
      "failed",
      errorCode,
      safeMessage,
      failedIso,
    );
    if (!updated) throw new EasyEmailError("SEND_QUEUE_LEASE_LOST", "Send queue lease expired during processing.");
    return { processedCount: 1, sentCount: 0, retryCount: 0, failedCount: 1 };
  }
}
