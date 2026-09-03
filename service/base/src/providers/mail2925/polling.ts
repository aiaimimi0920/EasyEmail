import type { ObservedMessage } from "../../domain/models.js";
import {
  extractOtp,
  matchesAliasRecipient,
  matchesSenderFilter,
  normalizeAddress,
  normalizeFilter,
  readMessageHtml,
  readMessageId,
  readMessageSubject,
  readMessageText,
  readMessageTimestampMs,
  readObservedAt,
  readRecipients,
  readSender,
} from "./payload.js";
import type { Mail2925AccountCredential, Mail2925MailboxRefPayload } from "./types.js";

interface Mail2925PollingContext {
  sessionId: string;
  mailbox: Mail2925MailboxRefPayload;
  providerInstanceId: string;
  fromContains?: string;
  account: Mail2925AccountCredential;
  defaultFolderName: string;
  listMessages(folderName: string): Promise<Record<string, unknown>[]>;
  getMessage(messageId: string, folderName: string): Promise<Record<string, unknown>>;
}

export async function tryReadLatestMail2925Code(
  context: Mail2925PollingContext,
): Promise<ObservedMessage | undefined> {
  const folderName = context.mailbox.folderName ?? context.defaultFolderName;
  const messages = await context.listMessages(folderName);
  const aliasAddress = normalizeAddress(context.mailbox.aliasAddress);
  if (!aliasAddress) {
    return undefined;
  }

  const staleThresholdMs = 30 * 60 * 1000;
  const nowMs = Date.now();

  for (const summary of messages) {
    const messageTimeMs = readMessageTimestampMs(summary);
    if (messageTimeMs > 0 && (nowMs - messageTimeMs) > staleThresholdMs) {
      break;
    }

    const sender = readSender(summary);
    if (!matchesSenderFilter(sender, context.fromContains)) {
      continue;
    }

    const summaryRecipients = readRecipients(summary);
    const aliasMatchesSummary = summaryRecipients.length > 0
      ? matchesAliasRecipient(summaryRecipients, aliasAddress, context.account.accountEmail)
      : false;

    if (summaryRecipients.length > 0 && !aliasMatchesSummary) {
      continue;
    }

    const messageId = readMessageId(summary);
    const subject = readMessageSubject(summary);
    const summaryText = readMessageText(summary);
    const summaryHtml = readMessageHtml(summary);
    const observedAt = readObservedAt(summary) ?? "";
    const summaryOtp = extractOtp({
      subject,
      textBody: summaryText,
      htmlBody: summaryHtml,
    });

    if (aliasMatchesSummary && (summaryText || summaryHtml) && !messageId) {
      return {
        id: `mail2925:${summaryOtp?.code ?? observedAt ?? "summary"}`,
        sessionId: context.sessionId,
        providerInstanceId: context.providerInstanceId,
        observedAt,
        sender,
        subject,
        textBody: summaryText,
        htmlBody: summaryHtml,
        extractedCode: summaryOtp?.code,
        codeSource: summaryOtp?.source,
      };
    }

    if (!messageId) {
      continue;
    }

    let detail: Record<string, unknown> = {};
    try {
      detail = await context.getMessage(messageId, folderName);
    } catch {
      if (!aliasMatchesSummary || (!summaryText && !summaryHtml)) {
        continue;
      }

      return {
        id: `mail2925:${messageId}`,
        sessionId: context.sessionId,
        providerInstanceId: context.providerInstanceId,
        observedAt,
        sender,
        subject,
        textBody: summaryText,
        htmlBody: summaryHtml,
        extractedCode: summaryOtp?.code,
        codeSource: summaryOtp?.source,
      };
    }
    const recipients = readRecipients(detail);
    const aliasMatches = recipients.length > 0
      ? matchesAliasRecipient(recipients, aliasAddress, context.account.accountEmail)
      : (
        normalizeFilter(readMessageSubject(detail))?.includes(aliasAddress)
        || normalizeFilter(readMessageText(detail))?.includes(aliasAddress)
        || normalizeFilter(readMessageHtml(detail))?.includes(aliasAddress)
      );
    if (!aliasMatches) {
      continue;
    }

    const detailSender = readSender(detail) ?? sender;
    if (!matchesSenderFilter(detailSender, context.fromContains)) {
      continue;
    }

    const detailSubject = readMessageSubject(detail) ?? subject;
    const detailText = readMessageText(detail) ?? summaryText;
    const detailHtml = readMessageHtml(detail) ?? summaryHtml;
    const detailOtp = extractOtp({
      subject: detailSubject,
      textBody: detailText,
      htmlBody: detailHtml,
    });
    if (!detailOtp) {
      if (!aliasMatchesSummary || (!summaryText && !summaryHtml)) {
        continue;
      }

      return {
        id: `mail2925:${messageId}`,
        sessionId: context.sessionId,
        providerInstanceId: context.providerInstanceId,
        observedAt,
        sender,
        subject,
        textBody: summaryText,
        htmlBody: summaryHtml,
        extractedCode: summaryOtp?.code,
        codeSource: summaryOtp?.source,
      };
    }
    return {
      id: `mail2925:${messageId}`,
      sessionId: context.sessionId,
      providerInstanceId: context.providerInstanceId,
      observedAt: readObservedAt(detail) ?? observedAt,
      sender: detailSender,
      subject: detailSubject,
      textBody: detailText,
      htmlBody: detailHtml,
      extractedCode: detailOtp.code,
      codeSource: detailOtp.source,
    };
  }

  return undefined;
}
