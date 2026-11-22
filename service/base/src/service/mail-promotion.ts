import { randomUUID } from "node:crypto";

import type { MailAccountRepository } from "../domain/account.js";
import { EasyEmailError } from "../domain/errors.js";
import type {
  PromoteMailboxSessionInput,
  PromoteMailboxSessionResult,
} from "../domain/mail-extensions.js";
import type { EasyEmailService } from "./easy-email-service.js";
import type { MailMessageService } from "./mail-messages.js";

export interface MailPromotionServiceDependencies {
  flushPersistedState?: () => Promise<void>;
}

const KNOWN_PROMOTE_FIELDS = new Set(["confirmLifecycleAck", "displayName"]);

function isAddressConflictError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  return (
    record.code === "ERR_SQLITE_ERROR"
    && typeof record.message === "string"
    && record.message.includes("idx_mail_accounts_live_address")
  );
}

export class MailPromotionService {
  public constructor(
    private readonly easyEmailService: EasyEmailService,
    private readonly accountRepository: MailAccountRepository,
    private readonly messageService: MailMessageService,
    private readonly now: () => Date = () => new Date(),
    private readonly dependencies: MailPromotionServiceDependencies = {},
  ) {}

  public async promoteMailboxSession(
    rawSessionId: string,
    rawInput: PromoteMailboxSessionInput,
  ): Promise<PromoteMailboxSessionResult> {
    const sessionId = rawSessionId.trim();
    if (!sessionId) {
      throw new EasyEmailError("INVALID_QUERY", "Mailbox session id is required.");
    }
    if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
      throw new EasyEmailError("INVALID_REQUEST", "Promotion request body must be a JSON object.");
    }
    for (const key of Object.keys(rawInput)) {
      if (!KNOWN_PROMOTE_FIELDS.has(key)) {
        throw new EasyEmailError("INVALID_REQUEST", `Unknown promotion field: ${key}`);
      }
    }
    if (rawInput.confirmLifecycleAck !== true) {
      throw new EasyEmailError(
        "TEMP_PROMOTE_CONFIRMATION_REQUIRED",
        "Confirm that promotion does not extend the temporary mailbox provider lifetime.",
      );
    }

    const snapshot = this.easyEmailService.getSnapshot();
    const session = snapshot.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) {
      throw new EasyEmailError(
        "MAILBOX_SESSION_NOT_FOUND",
        `Unknown mailbox session: ${sessionId}.`,
      );
    }

    if (
      session.metadata.visibilityState === "upgraded"
      || Boolean(session.metadata.upgradedAccountId)
      || session.metadata.visibilityState === "archived"
    ) {
      throw new EasyEmailError(
        "TEMP_PROMOTE_NOT_AVAILABLE",
        "Only anonymous temporary mailboxes can be promoted.",
      );
    }

    if (session.metadata.promotionUnsupported === "true") {
      throw new EasyEmailError(
        "TEMP_PROMOTE_PROVIDER_UNSUPPORTED",
        `Provider ${session.providerTypeKey} does not support temporary mailbox promotion.`,
      );
    }

    let displayName = session.emailAddress;
    if (rawInput.displayName !== undefined && rawInput.displayName !== null) {
      if (typeof rawInput.displayName !== "string") {
        throw new EasyEmailError("INVALID_REQUEST", "displayName must be a string.");
      }
      const trimmed = rawInput.displayName.trim();
      if (trimmed.length > 120) {
        throw new EasyEmailError("INVALID_REQUEST", "displayName must be at most 120 characters.");
      }
      if (trimmed) {
        displayName = trimmed;
      }
    }

    const instance = snapshot.instances.find((item) => item.id === session.providerInstanceId);
    const providerLabel =
      instance?.displayName?.trim()
      || session.metadata.providerLabel?.trim()
      || session.providerTypeKey;
    const nowDate = this.now();
    const nowIso = nowDate.toISOString();
    const expiresAtMs = session.expiresAt ? Date.parse(session.expiresAt) : Number.NaN;
    const isExpiredByLease = Number.isFinite(expiresAtMs) && expiresAtMs <= nowDate.getTime();
    const isReleased = Boolean(session.metadata.releasedAt);
    const isSessionActive = session.status !== "expired" && !isReleased && !isExpiredByLease;

    let account;
    try {
      account = await this.accountRepository.createMailAccount({
        id: `acct_v1_${randomUUID()}`,
        scope: "normal",
        kind: "normal_upgraded_temp",
        displayName,
        primaryAddress: session.emailAddress.trim().toLowerCase(),
        providerLabel,
        status: isSessionActive ? "ready" : "history_only",
        authStatus: "not_required",
        receiveStatus: isSessionActive ? "enabled" : "expired",
        sendStatus: "unsupported",
        listedInAllAccounts: true,
        now: nowIso,
        credentialRefs: [],
      });
    } catch (error) {
      if (isAddressConflictError(error)) {
        throw new EasyEmailError(
          "ACCOUNT_ADDRESS_CONFLICT",
          "An active account already uses that email address.",
        );
      }
      throw error;
    }

    await this.messageService.ingestObservedMessages();
    const { linkedCount: linkedMessageCount } =
      await this.messageService.promoteTemporarySessionMessages(session.id, account.id);

    const updatedSession = this.easyEmailService.updateMailboxSession({
      sessionId: session.id,
      metadata: {
        ...session.metadata,
        visibilityState: "upgraded",
        upgradedAccountId: account.id,
        updatedAt: nowIso,
      },
    });

    await this.dependencies.flushPersistedState?.();

    return {
      account,
      session: updatedSession,
      linkedMessageCount,
    };
  }
}

export function createMailPromotionService(
  easyEmailService: EasyEmailService,
  accountRepository: MailAccountRepository,
  messageService: MailMessageService,
  now?: () => Date,
  dependencies?: MailPromotionServiceDependencies,
): MailPromotionService {
  return new MailPromotionService(
    easyEmailService,
    accountRepository,
    messageService,
    now,
    dependencies,
  );
}
