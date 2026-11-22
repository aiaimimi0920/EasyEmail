import { createHash, randomUUID } from "node:crypto";

import type { MailAccount, MailCredentialRef } from "../domain/account.js";
import { EasyEmailError } from "../domain/errors.js";
import type {
  MailAgentAccountCreateInput,
  MailAgentAccountListQuery,
  MailAgentAccountListResult,
  MailAgentIncomingReplyAssociationResult,
  MailAgentRepository,
  MailAgentServiceCreateInput,
  MailAgentServiceRecord,
  MailAgentTaskSendInput,
  MailAgentTaskSendResult,
  MailAgentThread,
  MailAgentThreadDetail,
  MailAgentThreadListQuery,
  MailAgentThreadStatus,
  MailAgentTrustLevel,
} from "../domain/mail-agent.js";
import { assertNoRawSecretFields, assertOnlyKnownFields } from "./account-validation.js";
import type { MailAccountService } from "./accounts.js";
import type { MailAgentImapReplyAssociator } from "./mail-imap-sync.js";
import { extractSnippetFromBodies } from "./mail-html-sanitizer.js";

const TRUST_LEVELS = new Set<MailAgentTrustLevel>([
  "unknown",
  "trusted",
  "restricted",
  "blocked",
]);

const THREAD_STATUSES = new Set<MailAgentThreadStatus>([
  "draft",
  "sent",
  "awaiting_reply",
  "in_progress",
  "completed",
  "failed",
  "expired",
  "needs_attention",
  "archived",
]);

const AGENT_ACCOUNT_CREATE_FIELDS = new Set([
  "displayName",
  "emailAddress",
  "providerLabel",
  "imap",
  "smtp",
  "credentialRefs",
]);

const AGENT_SERVICE_CREATE_FIELDS = new Set([
  "displayName",
  "emailAddress",
  "description",
  "serviceKind",
  "trustLevel",
  "defaultSenderAccountId",
]);

const AGENT_TASK_SEND_FIELDS = new Set([
  "agentServiceId",
  "senderAccountId",
  "subject",
  "bodyText",
  "confirmRestricted",
  "idempotencyKey",
]);

function normalizeAgentEmail(rawValue: unknown, fieldName: string): string {
  if (typeof rawValue !== "string") {
    throw new EasyEmailError("INVALID_AGENT_REQUEST", `${fieldName} must be an email string.`);
  }
  const trimmed = rawValue.trim().toLowerCase();
  const atIndex = trimmed.lastIndexOf("@");
  if (
    !trimmed
    || trimmed.length > 320
    || /\s/u.test(trimmed)
    || atIndex <= 0
    || atIndex >= trimmed.length - 1
    || !trimmed.slice(atIndex + 1).includes(".")
  ) {
    throw new EasyEmailError("INVALID_AGENT_REQUEST", `${fieldName} is not a valid email address.`);
  }
  return trimmed;
}

function selectAgentSmtpCredentialRef(account: MailAccount): MailCredentialRef | undefined {
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

function isServiceEmailConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  return (
    record.code === "ERR_SQLITE_ERROR"
    && typeof record.message === "string"
    && record.message.includes("idx_mail_agent_services_email_active")
  );
}

function dedupeReplyCandidateIds(
  inReplyTo?: string,
  references: readonly string[] = [],
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const rawList = [
    ...(inReplyTo ? [inReplyTo] : []),
    ...references.flatMap((entry) => entry.split(/\s+/u)),
  ];
  for (const item of rawList) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      result.push(trimmed);
    }
  }
  return result;
}

export class MailAgentService implements MailAgentImapReplyAssociator {
  public constructor(
    private readonly repository: MailAgentRepository,
    private readonly accountService: MailAccountService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async createAgentAccount(input: MailAgentAccountCreateInput): Promise<MailAccount> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new EasyEmailError("INVALID_AGENT_REQUEST", "Agent account request must be an object.");
    }
    assertNoRawSecretFields(input);
    assertOnlyKnownFields(
      input as unknown as Record<string, unknown>,
      AGENT_ACCOUNT_CREATE_FIELDS,
      "Agent account",
    );
    const emailAddress = normalizeAgentEmail(input.emailAddress, "emailAddress");
    return this.accountService.createAccount({
      scope: "agent",
      kind: "agent_owned",
      displayName: input.displayName,
      primaryAddress: emailAddress,
      providerLabel: input.providerLabel,
      imap: input.imap,
      smtp: input.smtp,
      listedInAllAccounts: false,
      credentialRefs: input.credentialRefs,
    });
  }

  public async listAgentAccounts(
    query: MailAgentAccountListQuery = {},
  ): Promise<MailAgentAccountListResult> {
    return this.accountService.listAccounts({
      scope: "agent",
      limit: query.limit,
      cursor: query.cursor,
    });
  }

  public async createAgentService(
    input: MailAgentServiceCreateInput,
  ): Promise<MailAgentServiceRecord> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new EasyEmailError("INVALID_AGENT_REQUEST", "Agent service request must be an object.");
    }
    assertOnlyKnownFields(
      input as unknown as Record<string, unknown>,
      AGENT_SERVICE_CREATE_FIELDS,
      "Agent service",
    );
    const displayName = typeof input.displayName === "string" ? input.displayName.trim() : "";
    if (!displayName || displayName.length > 128) {
      throw new EasyEmailError(
        "INVALID_AGENT_REQUEST",
        "displayName must be 1 to 128 non-empty characters.",
      );
    }
    const emailAddress = normalizeAgentEmail(input.emailAddress, "emailAddress");
    if (typeof input.trustLevel !== "string" || !TRUST_LEVELS.has(input.trustLevel as MailAgentTrustLevel)) {
      throw new EasyEmailError(
        "INVALID_AGENT_REQUEST",
        "trustLevel must be unknown, trusted, restricted, or blocked.",
      );
    }
    const description =
      typeof input.description === "string" && input.description.trim()
        ? input.description.trim().slice(0, 2000)
        : undefined;
    const serviceKind =
      typeof input.serviceKind === "string" && input.serviceKind.trim()
        ? input.serviceKind.trim().slice(0, 64)
        : "email_agent";

    let defaultSenderAccountId: string | undefined;
    if (input.defaultSenderAccountId !== undefined && input.defaultSenderAccountId !== null) {
      if (typeof input.defaultSenderAccountId !== "string") {
        throw new EasyEmailError(
          "INVALID_AGENT_REQUEST",
          "defaultSenderAccountId must be a string.",
        );
      }
      const trimmedSenderId = input.defaultSenderAccountId.trim();
      if (trimmedSenderId) {
        const sender = await this.accountService.getAccount(trimmedSenderId);
        if (sender.scope !== "agent") {
          throw new EasyEmailError(
            "AGENT_SENDER_SCOPE_REQUIRED",
            "Default sender for an Agent service must be an Agent-scoped account.",
          );
        }
        defaultSenderAccountId = sender.id;
      }
    }

    try {
      return await this.repository.createAgentService({
        id: `agsvc_v1_${randomUUID()}`,
        displayName,
        emailAddress,
        description,
        serviceKind,
        trustLevel: input.trustLevel,
        defaultSenderAccountId,
        now: this.now().toISOString(),
      });
    } catch (error) {
      if (isServiceEmailConflict(error)) {
        throw new EasyEmailError(
          "AGENT_SERVICE_EMAIL_CONFLICT",
          "An active remote Agent service already uses that email address.",
        );
      }
      throw error;
    }
  }

  public async listAgentServices(): Promise<MailAgentServiceRecord[]> {
    return this.repository.listAgentServices();
  }

  public async sendAgentTask(
    input: MailAgentTaskSendInput,
    headerIdempotencyKey?: string,
  ): Promise<MailAgentTaskSendResult> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new EasyEmailError("INVALID_AGENT_REQUEST", "Agent task request must be an object.");
    }
    assertOnlyKnownFields(
      input as unknown as Record<string, unknown>,
      AGENT_TASK_SEND_FIELDS,
      "Agent task",
    );

    const agentServiceId = typeof input.agentServiceId === "string" ? input.agentServiceId.trim() : "";
    const senderAccountId = typeof input.senderAccountId === "string" ? input.senderAccountId.trim() : "";
    const subject = typeof input.subject === "string" ? input.subject.trim() : "";
    if (!agentServiceId || !senderAccountId || !subject) {
      throw new EasyEmailError(
        "INVALID_AGENT_TASK",
        "Select an Agent service, Agent sender account, and non-empty subject.",
      );
    }
    if (subject.length > 998) {
      throw new EasyEmailError("INVALID_AGENT_TASK", "Task subject exceeds maximum length.");
    }
    if (typeof input.bodyText !== "string") {
      throw new EasyEmailError("INVALID_AGENT_TASK", "bodyText must be a string.");
    }
    if (typeof input.confirmRestricted !== "boolean") {
      throw new EasyEmailError("INVALID_AGENT_TASK", "confirmRestricted must be a boolean.");
    }

    const rawIdem = headerIdempotencyKey?.trim() || input.idempotencyKey?.trim() || undefined;
    if (rawIdem && rawIdem.length > 256) {
      throw new EasyEmailError(
        "INVALID_AGENT_TASK",
        "Idempotency-Key must be at most 256 characters.",
      );
    }

    const sender = await this.accountService.getAccount(senderAccountId);
    if (sender.scope !== "agent") {
      throw new EasyEmailError(
        "AGENT_SENDER_SCOPE_REQUIRED",
        "Agent task mail must be sent from an Agent-scoped account.",
      );
    }
    if (sender.status === "disabled" || sender.sendStatus !== "enabled") {
      throw new EasyEmailError(
        "AGENT_SENDER_SEND_NOT_ENABLED",
        "The Agent sender account is not enabled for SMTP sending.",
      );
    }
    if (!sender.smtp || !sender.primaryAddress) {
      throw new EasyEmailError(
        "AGENT_SENDER_SMTP_MISSING",
        "The Agent sender account does not configure an SMTP profile.",
      );
    }
    const credentialRef = selectAgentSmtpCredentialRef(sender);
    if (!credentialRef) {
      throw new EasyEmailError(
        "ACCOUNT_REAUTHENTICATION_REQUIRED",
        "The Agent sender account SMTP credential must be configured before sending.",
      );
    }

    const service = await this.repository.getAgentService(agentServiceId);
    if (!service || service.status !== "active") {
      throw new EasyEmailError(
        "AGENT_SERVICE_NOT_FOUND",
        `Remote Agent service ${agentServiceId} was not found.`,
      );
    }
    if (service.trustLevel === "blocked") {
      throw new EasyEmailError(
        "AGENT_SERVICE_BLOCKED",
        "This remote Agent service is blocked.",
      );
    }
    if (service.trustLevel === "restricted" && !input.confirmRestricted) {
      throw new EasyEmailError(
        "AGENT_SERVICE_RESTRICTED_CONFIRMATION_REQUIRED",
        "Confirm before sending a task to a restricted Agent service.",
      );
    }

    const snippet = extractSnippetFromBodies(input.bodyText, undefined, subject);
    const payloadFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          agentServiceId: service.id,
          senderAccountId: sender.id,
          subject,
          bodyText: input.bodyText,
        }),
        "utf8",
      )
      .digest("hex");

    return this.repository.enqueueAgentTask({
      agentServiceId: service.id,
      targetAddress: service.emailAddress,
      senderAccountId: sender.id,
      senderAddress: sender.primaryAddress,
      senderName: sender.displayName,
      providerLabel: sender.providerLabel ?? sender.displayName,
      smtpHost: sender.smtp.host,
      smtpPort: sender.smtp.port,
      smtpSecurity: sender.smtp.security,
      smtpUsername: sender.smtp.username,
      credentialRefId: credentialRef.id,
      subject,
      snippet,
      bodyText: input.bodyText,
      idempotencyKey: rawIdem,
      payloadFingerprint,
      now: this.now().toISOString(),
    });
  }

  public async listAgentThreads(query: MailAgentThreadListQuery = {}): Promise<MailAgentThread[]> {
    let status: MailAgentThreadStatus | undefined;
    if (query.status !== undefined) {
      if (!THREAD_STATUSES.has(query.status)) {
        throw new EasyEmailError("INVALID_QUERY", `Unsupported Agent thread status: ${query.status}.`);
      }
      status = query.status;
    }
    const limit = query.limit ?? 200;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new EasyEmailError("INVALID_QUERY", "limit must be an integer from 1 to 500.");
    }
    return this.repository.listAgentThreads({
      status,
      senderAccountId: query.senderAccountId?.trim() || undefined,
      agentServiceId: query.agentServiceId?.trim() || undefined,
      limit,
    });
  }

  public async getAgentThreadDetail(threadId: string): Promise<MailAgentThreadDetail> {
    const trimmed = threadId.trim();
    if (!trimmed) {
      throw new EasyEmailError("INVALID_QUERY", "threadId is required.");
    }
    const detail = await this.repository.getAgentThreadDetail(trimmed);
    if (!detail) {
      throw new EasyEmailError(
        "AGENT_THREAD_NOT_FOUND",
        `Agent thread ${trimmed} was not found.`,
      );
    }
    return detail;
  }

  public async associateImapIncomingMessage(input: {
    accountId: string;
    messageId: string;
    fromAddress: string;
    subject: string;
    inReplyTo?: string;
    references: string[];
  }): Promise<MailAgentIncomingReplyAssociationResult | undefined> {
    const fromNormalized = input.fromAddress.trim().toLowerCase();
    if (!fromNormalized) {
      return undefined;
    }
    const service = await this.repository.getAgentServiceByEmail(fromNormalized);
    if (!service || service.status !== "active" || service.trustLevel === "blocked") {
      return undefined;
    }
    const candidateRfcIds = dedupeReplyCandidateIds(input.inReplyTo, input.references);
    return this.repository.associateIncomingAgentReply({
      agentServiceId: service.id,
      fallbackSenderAccountId: input.accountId,
      messageId: input.messageId,
      subject: input.subject,
      candidateRfcIds,
      now: this.now().toISOString(),
    });
  }
}

export function createMailAgentService(
  repository: MailAgentRepository,
  accountService: MailAccountService,
  now?: () => Date,
): MailAgentService {
  return new MailAgentService(repository, accountService, now);
}
