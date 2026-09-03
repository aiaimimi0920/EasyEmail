import { createId } from "../shared/index.js";
import { EasyEmailError } from "../domain/errors.js";
import { extractAuthenticationLinksFromContent } from "../domain/auth-links.js";
import { extractOtpCode } from "../domain/otp.js";
import type { MailRegistry } from "../domain/registry.js";
import {
  readAuthenticationLinkFromProvider,
  readVerificationCodeFromProvider,
} from "./mailbox.js";
import { reportMailboxOutcomeToRegistry } from "./outcomes.js";
import type { MailProviderAdapter } from "../providers/contracts.js";
import type {
  ActionLinkCandidate,
  AuthenticationLinkResult,
  MailboxOutcomeReport,
  MailboxOutcomeReportResult,
  MailboxSendRequest,
  MailboxSendResult,
  MailboxSession,
  MailboxSessionUpdateRequest,
  MailProviderTypeKey,
  ObserveMessageInput,
  ObservedMessage,
  VerificationCodeResult,
} from "../domain/models.js";

function resolveActionLinks(input: {
  sender?: string;
  subject?: string;
  textBody?: string;
  htmlBody?: string;
  actionLinks?: ActionLinkCandidate[];
}): ActionLinkCandidate[] | undefined {
  if (Array.isArray(input.actionLinks) && input.actionLinks.length > 0) {
    return [...input.actionLinks];
  }

  const extracted = extractAuthenticationLinksFromContent({
    sender: input.sender,
    subject: input.subject,
    textBody: input.textBody,
    htmlBody: input.htmlBody,
  });
  return extracted.length > 0 ? extracted : undefined;
}

export class EasyEmailMessageOperations {
  public constructor(
    private readonly registry: MailRegistry,
    private readonly adapterMap: Map<MailProviderTypeKey, MailProviderAdapter>,
    private readonly syncOperationalState: (now?: Date) => void,
  ) {}

  public observeMessage(input: ObserveMessageInput, now: Date = new Date()): ObservedMessage {
    const session = this.registry.findSessionById(input.sessionId);

    if (!session) {
      throw new EasyEmailError("MAILBOX_SESSION_NOT_FOUND", `Unknown mailbox session: ${input.sessionId}.`);
    }

    const extracted = extractOtpCode(input);
    const actionLinks = resolveActionLinks(input);
    const message: ObservedMessage = {
      id: createId("message", now),
      sessionId: session.id,
      providerInstanceId: session.providerInstanceId,
      observedAt: input.observedAt ?? now.toISOString(),
      sender: input.sender,
      subject: input.subject,
      htmlBody: input.htmlBody,
      textBody: input.textBody,
      extractedCode: extracted?.code,
      extractedCandidates: extracted?.candidates,
      codeSource: extracted?.source,
      ...(actionLinks ? { actionLinks } : {}),
    };

    this.registry.saveMessage(message);

    if (message.extractedCode) {
      this.registry.saveSession({
        ...session,
        status: "resolved",
      });
    }

    return message;
  }

  public async readVerificationCode(sessionId: string): Promise<VerificationCodeResult | undefined> {
    const result = await readVerificationCodeFromProvider({
      sessionId,
      registry: this.registry,
      adapterMap: this.adapterMap,
    });
    this.syncOperationalState();
    return result;
  }

  public async readAuthenticationLink(sessionId: string): Promise<AuthenticationLinkResult | undefined> {
    const result = await readAuthenticationLinkFromProvider({
      sessionId,
      registry: this.registry,
      adapterMap: this.adapterMap,
    });
    this.syncOperationalState();
    return result;
  }

  public async sendMailboxMessage(
    request: MailboxSendRequest,
    now: Date = new Date(),
  ): Promise<MailboxSendResult> {
    this.syncOperationalState(now);
    const session = this.registry.findSessionById(request.sessionId);
    if (!session) {
      throw new EasyEmailError("MAILBOX_SESSION_NOT_FOUND", `Unknown mailbox session: ${request.sessionId}.`);
    }

    const instance = this.registry.findInstanceById(session.providerInstanceId);
    if (!instance) {
      throw new EasyEmailError(
        "PROVIDER_INSTANCE_NOT_FOUND",
        `Unknown provider instance for mailbox session ${request.sessionId}: ${session.providerInstanceId}.`,
      );
    }

    const adapter = this.adapterMap.get(session.providerTypeKey);
    if (!adapter?.sendMailboxMessage) {
      throw new EasyEmailError(
        "MAILBOX_SEND_NOT_SUPPORTED",
        `Provider ${session.providerTypeKey} does not support mailbox sending.`,
      );
    }

    const credentialSets = this.registry.resolveCredentialSetsForInstance(instance.id, "generate");
    const result = await adapter.sendMailboxMessage({
      session,
      instance,
      credentialSets,
      now,
      request: {
        toEmailAddress: request.toEmailAddress,
        toName: request.toName,
        subject: request.subject,
        textBody: request.textBody,
        htmlBody: request.htmlBody,
        fromName: request.fromName,
      },
    });
    this.syncOperationalState(now);
    return result;
  }

  public updateMailboxSession(request: MailboxSessionUpdateRequest): MailboxSession {
    const session = this.registry.findSessionById(request.sessionId);
    if (!session) {
      throw new EasyEmailError("MAILBOX_SESSION_NOT_FOUND", `Unknown mailbox session: ${request.sessionId}.`);
    }

    const nextMetadata: Record<string, string> = {
      ...session.metadata,
      ...(request.metadata ?? {}),
    };

    if (typeof request.fromContains === "string") {
      const normalized = request.fromContains.trim();
      if (normalized) {
        nextMetadata.fromContains = normalized;
      } else {
        delete nextMetadata.fromContains;
      }
    }

    const updatedSession: MailboxSession = {
      ...session,
      metadata: nextMetadata,
    };
    this.registry.saveSession(updatedSession);
    return updatedSession;
  }

  public async syncObservedMessages(sessionId: string): Promise<ObservedMessage[]> {
    const beforeIds = new Set(this.registry.listMessagesBySession(sessionId).map((message) => message.id));
    const synced = await readVerificationCodeFromProvider({
      sessionId,
      registry: this.registry,
      adapterMap: this.adapterMap,
    });
    const allMessages = this.registry.listMessagesBySession(sessionId);
    const newMessages = allMessages.filter((message) => !beforeIds.has(message.id));
    this.syncOperationalState();
    if (newMessages.length > 0) {
      return newMessages;
    }
    if (synced?.observedMessageId) {
      const matched = allMessages.find((message) => message.id === synced.observedMessageId);
      if (matched) {
        return [matched];
      }
    }
    return [];
  }

  public reportMailboxOutcome(
    report: MailboxOutcomeReport,
    now: Date = new Date(),
  ): MailboxOutcomeReportResult {
    const result = reportMailboxOutcomeToRegistry(this.registry, report, now);
    this.syncOperationalState(now);
    return result;
  }
}
