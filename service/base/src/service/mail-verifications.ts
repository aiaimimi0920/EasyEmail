import { randomUUID } from "node:crypto";

import { EasyEmailError } from "../domain/errors.js";
import type {
  MailMessageDetail,
  MailMessageRepository,
  MailVerificationListQuery,
  MailVerificationRecord,
  MailVerificationRepository,
} from "../domain/mail-message.js";
import { extractOtpFromContent } from "../domain/otp.js";
import type { MailboxRefreshResult } from "../http/contracts.js";
import { refreshMailboxSessions } from "../http/mailbox-refresh-support.js";
import type { EasyEmailService } from "./easy-email-service.js";
import { parseSenderHeader } from "./mail-header-codec.js";
import {
  DEFAULT_VERIFICATION_PAGE_SIZE,
  MAX_VERIFICATION_PAGE_SIZE,
  normalizeMailMessageId,
  normalizeVerificationScope,
} from "./mail-message-validation.js";

const DEFAULT_OTP_VALIDITY_MINUTES = 15;
const EXPLICIT_MINUTES_RE =
  /(?:valid(?:\s+for)?|expires?\s+in|有效期(?:\s*为)?)\s*(\d{1,3})\s*(?:minutes?|mins?|分钟)/i;

function inferValidityMinutes(text: string): number {
  const matched = text.match(EXPLICIT_MINUTES_RE);
  if (!matched?.[1]) {
    return DEFAULT_OTP_VALIDITY_MINUTES;
  }
  const parsed = Number.parseInt(matched[1], 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1440) {
    return DEFAULT_OTP_VALIDITY_MINUTES;
  }
  return parsed;
}

function inferIssuerHint(fromAddress: string): string | undefined {
  const parsed = parseSenderHeader(fromAddress);
  if (parsed.fromName && parsed.fromName.length <= 80) {
    return parsed.fromName;
  }
  const emailMatch = fromAddress.match(/@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
  if (!emailMatch?.[1]) {
    return undefined;
  }
  const parts = emailMatch[1].toLowerCase().split(".").filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : parts[0];
}

function computeOtpConfidence(
  code: string,
  source: "subject" | "text" | "html",
  candidateCount: number,
): number {
  let score = source === "subject" ? 0.92 : source === "text" ? 0.88 : 0.82;
  if (/^\d{6}$/.test(code)) {
    score += 0.04;
  }
  if (candidateCount > 1) {
    score -= Math.min(0.14, (candidateCount - 1) * 0.05);
  }
  return Number(Math.max(0.55, Math.min(0.98, score)).toFixed(2));
}

export interface MailVerificationServiceDependencies {
  easyEmailService?: EasyEmailService;
  onBeforeQuery?: () => Promise<void>;
}

export class MailVerificationService {
  public constructor(
    private readonly messageRepository: MailMessageRepository,
    private readonly verificationRepository: MailVerificationRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly dependencies: MailVerificationServiceDependencies = {},
  ) {}

  public setBeforeQueryHook(hook: () => Promise<void>): void {
    this.dependencies.onBeforeQuery = hook;
  }

  public async classifyStoredMessage(
    messageId: string,
    options: { missingIsError?: boolean; targetServiceHint?: string } = {},
  ): Promise<MailVerificationRecord | undefined> {
    const source = await this.messageRepository.getMessageForVerification(messageId);
    if (!source) {
      if (options.missingIsError !== false) {
        throw new EasyEmailError("MAIL_MESSAGE_NOT_FOUND", `Mail message ${messageId} was not found.`);
      }
      return undefined;
    }

    const nowDate = this.now();
    const nowIso = nowDate.toISOString();
    const nowMs = nowDate.getTime();
    const extracted = extractOtpFromContent({
      sender: source.fromAddress,
      subject: source.subject,
      textBody: source.bodyText ?? source.snippet,
      htmlBody: source.bodyHtml,
    });

    if (!extracted) {
      await this.verificationRepository.deleteMailVerificationCodesForMessage(source.messageId);
      if (source.classification === "verification") {
        await this.messageRepository.setMailMessageClassification(
          source.messageId,
          "general",
          nowIso,
        );
      }
      return undefined;
    }

    const candidates = extracted.candidates?.length
      ? extracted.candidates
      : [extracted.code];
    const combinedText = `${source.subject} ${source.bodyText ?? source.snippet}`;
    const validityMinutes = inferValidityMinutes(combinedText);
    const observedMs = Date.parse(source.observedAt);
    const baseMs = Number.isFinite(observedMs) ? observedMs : nowMs;
    const expiresAt = new Date(baseMs + validityMinutes * 60 * 1000).toISOString();
    const sessionTargetHint = source.sessionId
      ? this.dependencies.easyEmailService
          ?.getSnapshot()
          .sessions.find((item) => item.id === source.sessionId)?.metadata?.targetService
      : undefined;

    const record = await this.verificationRepository.upsertMailVerificationCode(
      {
        id: `vcode_v1_${randomUUID()}`,
        messageId: source.messageId,
        sessionId: source.sessionId,
        sourceRefId: source.sourceRefId,
        accountScope: source.accountScope,
        receivedAddress: source.receivedAddress,
        code: extracted.code,
        codeSource: extracted.source,
        candidates,
        issuerHint: inferIssuerHint(source.fromAddress),
        targetServiceHint: options.targetServiceHint ?? sessionTargetHint,
        confidence: computeOtpConfidence(extracted.code, extracted.source, candidates.length),
        expiresAt,
        extractedAt: nowIso,
      },
      nowMs,
    );

    if (source.classification === "general") {
      await this.messageRepository.setMailMessageClassification(
        source.messageId,
        "verification",
        nowIso,
      );
    }

    return record;
  }

  public async listVerifications(
    query: MailVerificationListQuery = {},
  ): Promise<MailVerificationRecord[]> {
    const scope = normalizeVerificationScope(query.scope);
    const limit = query.limit ?? DEFAULT_VERIFICATION_PAGE_SIZE;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_VERIFICATION_PAGE_SIZE) {
      throw new EasyEmailError(
        "INVALID_QUERY",
        `Verification limit must be an integer from 1 to ${MAX_VERIFICATION_PAGE_SIZE}.`,
      );
    }
    const sessionId = query.sessionId?.trim() || undefined;
    await this.dependencies.onBeforeQuery?.();
    return this.verificationRepository.listMailVerificationCodes(
      {
        sessionId,
        scope,
        freshOnly: Boolean(query.freshOnly),
        limit,
      },
      this.now().getTime(),
    );
  }

  public async reclassifyMessage(messageId: string): Promise<MailVerificationRecord | undefined> {
    const normalizedId = normalizeMailMessageId(messageId);
    await this.dependencies.onBeforeQuery?.();
    return this.classifyStoredMessage(normalizedId, { missingIsError: true });
  }

  public async pollMailboxVerification(
    sessionId: string,
  ): Promise<{ refresh: MailboxRefreshResult; detectedCode?: MailVerificationRecord }> {
    const normalizedSessionId = normalizeMailMessageId(sessionId, "sessionId");
    const coreService = this.dependencies.easyEmailService;
    if (!coreService) {
      throw new EasyEmailError(
        "VERIFICATIONS_PERSISTENCE_UNAVAILABLE",
        "Mailbox verification polling is unavailable in this runtime.",
      );
    }
    const session = coreService.getSnapshot().sessions.find((item) => item.id === normalizedSessionId);
    if (!session) {
      throw new EasyEmailError(
        "MAILBOX_SESSION_NOT_FOUND",
        `Unknown mailbox session: ${normalizedSessionId}.`,
      );
    }

    await this.dependencies.onBeforeQuery?.();
    const beforeMs = this.now().getTime();
    const previousLatest = (
      await this.verificationRepository.listMailVerificationCodes(
        { sessionId: normalizedSessionId, scope: "all", limit: 1 },
        beforeMs,
      )
    )[0];

    const refresh = await refreshMailboxSessions(coreService, [session], false);
    await this.dependencies.onBeforeQuery?.();

    const afterMs = this.now().getTime();
    const currentLatest = (
      await this.verificationRepository.listMailVerificationCodes(
        { sessionId: normalizedSessionId, scope: "all", limit: 1 },
        afterMs,
      )
    )[0];

    const isNewlyDetected = Boolean(
      currentLatest
      && (
        !previousLatest
        || currentLatest.id !== previousLatest.id
        || currentLatest.extractedAt !== previousLatest.extractedAt
      ),
    );

    return {
      refresh,
      ...(isNewlyDetected && currentLatest ? { detectedCode: currentLatest } : {}),
    };
  }
}

export function createMailVerificationService(
  messageRepository: MailMessageRepository,
  verificationRepository: MailVerificationRepository,
  now?: () => Date,
  dependencies?: MailVerificationServiceDependencies,
): MailVerificationService {
  return new MailVerificationService(
    messageRepository,
    verificationRepository,
    now,
    dependencies,
  );
}

export type { MailMessageDetail };
