import type {
  MailMessageClassification,
  MailMessageLifecycleState,
  MailMessageRepository,
  MailMessageSourceKind,
} from "../domain/mail-message.js";
import type { EasyEmailService } from "./easy-email-service.js";
import { decodeMimeHeaderWords, parseSenderHeader } from "./mail-header-codec.js";
import { extractSnippetFromBodies } from "./mail-html-sanitizer.js";
import type { MailVerificationService } from "./mail-verifications.js";

export interface ExternalMailMessageInput {
  messageId?: string;
  rfcMessageId?: string;
  threadKey?: string;
  sourceKind: Exclude<MailMessageSourceKind, "local_draft">;
  sourceRefId: string;
  accountId?: string;
  sessionId?: string;
  providerInstanceId?: string;
  externalMessageId?: string;
  receivedAddress: string;
  providerLabel: string;
  lifecycleState?: MailMessageLifecycleState;
  subject?: string;
  sender?: string;
  bodyText?: string;
  bodyHtml?: string;
  hasAttachments?: boolean;
  classification?: MailMessageClassification;
  observedAt?: string;
}

export async function ingestRuntimeObservedMessages(options: {
  repository: MailMessageRepository;
  easyEmailService?: EasyEmailService;
  verificationService?: MailVerificationService;
  nowIso: string;
}): Promise<number> {
  const { repository, easyEmailService, verificationService, nowIso } = options;
  if (!easyEmailService) {
    return 0;
  }
  const snapshot = easyEmailService.getSnapshot();
  if (snapshot.messages.length === 0) {
    return 0;
  }

  const sessionsById = new Map(snapshot.sessions.map((session) => [session.id, session]));
  const instancesById = new Map(snapshot.instances.map((instance) => [instance.id, instance]));
  let insertedCount = 0;

  for (const observed of snapshot.messages) {
    const session = sessionsById.get(observed.sessionId);
    const instance = instancesById.get(observed.providerInstanceId);
    const lifecycleState: MailMessageLifecycleState = !session
      ? "history_only"
      : session.status === "open"
        ? "active"
        : session.status === "expired"
          ? "expired"
          : "released";
    const subject = decodeMimeHeaderWords(observed.subject) || "(no subject)";
    const parsedSender = parseSenderHeader(observed.sender);
    const providerLabel =
      instance?.displayName?.trim()
      || session?.providerTypeKey
      || observed.providerInstanceId;
    const snippet = extractSnippetFromBodies(observed.textBody, observed.htmlBody, subject);

    const ingested = await repository.ingestMailMessage({
      messageId: observed.id,
      sourceKind: "temporary_session",
      sourceRefId: observed.sessionId,
      sessionId: observed.sessionId,
      providerInstanceId: observed.providerInstanceId,
      externalMessageId: observed.id,
      receivedAddress: session?.emailAddress ?? "",
      providerLabel,
      lifecycleState,
      subject,
      fromAddress: parsedSender.fromAddress,
      fromName: parsedSender.fromName,
      snippet,
      bodyText: observed.textBody,
      bodyHtml: observed.htmlBody,
      classification: observed.extractedCode ? "verification" : "general",
      observedAt: observed.observedAt,
      now: nowIso,
    });

    if (ingested.insertedMessage) {
      insertedCount += 1;
    }
    if (!ingested.deleted && (ingested.insertedMessage || ingested.insertedSource)) {
      await verificationService?.classifyStoredMessage(ingested.messageId, {
        missingIsError: false,
        targetServiceHint: session?.metadata?.targetService,
      });
    }
  }

  return insertedCount;
}

export async function ingestExternalMailMessage(options: {
  repository: MailMessageRepository;
  verificationService?: MailVerificationService;
  input: ExternalMailMessageInput;
  nowIso: string;
}): Promise<{ messageId: string }> {
  const { repository, verificationService, input, nowIso } = options;
  const subject = decodeMimeHeaderWords(input.subject) || "(no subject)";
  const parsedSender = parseSenderHeader(input.sender);
  const snippet = extractSnippetFromBodies(input.bodyText, input.bodyHtml, subject);
  const ingested = await repository.ingestMailMessage({
    messageId: input.messageId,
    rfcMessageId: input.rfcMessageId?.trim() || undefined,
    threadKey: input.threadKey?.trim() || undefined,
    sourceKind: input.sourceKind,
    sourceRefId: input.sourceRefId.trim(),
    accountId: input.accountId?.trim() || undefined,
    sessionId: input.sessionId?.trim() || undefined,
    providerInstanceId: input.providerInstanceId?.trim() || undefined,
    externalMessageId: input.externalMessageId?.trim() || undefined,
    receivedAddress: input.receivedAddress.trim(),
    providerLabel: input.providerLabel.trim() || "External",
    lifecycleState: input.lifecycleState ?? "ready",
    subject,
    fromAddress: parsedSender.fromAddress,
    fromName: parsedSender.fromName,
    snippet,
    bodyText: input.bodyText,
    bodyHtml: input.bodyHtml,
    hasAttachments: Boolean(input.hasAttachments),
    classification: input.classification ?? "general",
    observedAt: input.observedAt ?? nowIso,
    now: nowIso,
  });

  if (!ingested.deleted && (ingested.insertedMessage || ingested.insertedSource)) {
    await verificationService?.classifyStoredMessage(ingested.messageId, {
      missingIsError: false,
    });
  }
  return { messageId: ingested.messageId };
}
