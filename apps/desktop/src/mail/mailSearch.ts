import {
  visibleMailMessageHasAttachment,
  visibleMailMessageSortTimestamp,
  type MailListMessage,
} from "./mailSelectors.ts";

export type MailSearchMessage = MailListMessage & {
  temp_mailbox_id: string;
  sourceId: string;
  sourceLabel: string;
  local_folder: string;
  account_id?: string;
};

export type VerificationCodeDto = {
  id: string;
  message_id: string;
  temp_mailbox_id: string | null;
  source_id: string;
  account_scope: string;
  received_address: string;
  code: string;
  issuer_hint: string | null;
  target_service_hint: string | null;
  confidence: number;
  expires_at: string | null;
  extracted_at: string;
  subject: string;
  from_address: string;
  observed_at: string;
};

export type MailSearchAdvancedFilters = {
  query: string;
  fullText: boolean;
  startDate: string;
  endDate: string;
  sender: string;
  recipient: string;
  address: string;
  hasAttachment: boolean;
};

function parseDateInputBoundary(value: string, endOfDay: boolean): number | null {
  if (!value) {
    return null;
  }
  const suffix = endOfDay ? "T23:59:59.999" : "T00:00:00";
  const timestamp = new Date(`${value}${suffix}`).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function visibleMailMessageSearchText(
  message: MailSearchMessage,
  fullText = true,
): string {
  const fields = [
    message.subject,
    message.from_address,
    message.received_address,
    message.sourceLabel,
    message.local_folder,
    ...message.labels,
  ];
  if (fullText) {
    fields.push(message.snippet, message.body_text ?? "");
  }
  return fields.join(" ").toLowerCase();
}

export function detectInlineVerificationCode<TMessage extends MailSearchMessage>(
  message: TMessage,
): VerificationCodeDto | null {
  const sources = [message.subject, message.snippet, message.body_text ?? ""];
  const combined = sources.join(" ").toLowerCase();
  const hasKeyword = [
    "verification",
    "verify",
    "code",
    "otp",
    "passcode",
    "one-time",
    "security",
    "login",
    "sign in",
    "验证码",
    "校验码",
    "动态码",
  ].some((keyword) => combined.includes(keyword));
  const matches = sources.join(" ").match(/\b\d{4,8}\b/g);
  if (!matches?.length) {
    return null;
  }
  const preferred =
    matches.find((value) => value.length === 6) ??
    matches.find((value) => value.length === 5 || value.length === 4) ??
    matches[0];
  if (!preferred || (!hasKeyword && preferred.length !== 6)) {
    return null;
  }
  return {
    id: `inline:${message.message_id}`,
    message_id: message.message_id,
    temp_mailbox_id: message.temp_mailbox_id,
    source_id: message.sourceId,
    account_scope: message.account_id ? "normal_account" : "anonymous",
    received_address: message.received_address,
    code: preferred,
    issuer_hint: null,
    target_service_hint: null,
    confidence: hasKeyword ? 0.78 : 0.64,
    expires_at: null,
    extracted_at: message.observed_at,
    subject: message.subject,
    from_address: message.from_address,
    observed_at: message.observed_at,
  };
}

export function mailSearchMessageMatchesAdvancedFilters(
  message: MailSearchMessage,
  filters: MailSearchAdvancedFilters,
): boolean {
  const query = filters.query.trim().toLowerCase();
  if (query && !visibleMailMessageSearchText(message, filters.fullText).includes(query)) {
    return false;
  }

  const observedAt = visibleMailMessageSortTimestamp(message.observed_at);
  const startAt = parseDateInputBoundary(filters.startDate, false);
  if (startAt !== null && observedAt > 0 && observedAt < startAt) {
    return false;
  }

  const endAt = parseDateInputBoundary(filters.endDate, true);
  if (endAt !== null && observedAt > 0 && observedAt > endAt) {
    return false;
  }

  const sender = filters.sender.trim().toLowerCase();
  if (sender && !message.from_address.toLowerCase().includes(sender)) {
    return false;
  }

  const recipient = filters.recipient.trim().toLowerCase();
  if (recipient && !message.received_address.toLowerCase().includes(recipient)) {
    return false;
  }

  const address = filters.address.trim().toLowerCase();
  if (
    address &&
    address !== "all" &&
    message.received_address.toLowerCase() !== address &&
    message.account_id?.toLowerCase() !== address
  ) {
    return false;
  }

  return !filters.hasAttachment || visibleMailMessageHasAttachment(message);
}
