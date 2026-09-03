import { extractOtpFromContent } from "../../domain/otp.js";

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : {};
}

function asRecordList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item) => item && typeof item === "object") as Record<string, unknown>[]
    : [];
}

export function readString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return undefined;
}

export function readEnvelopeCode(body: unknown): number | undefined {
  const code = asRecord(body).code;
  if (typeof code === "number" && Number.isFinite(code)) {
    return code;
  }
  if (typeof code === "string" && code.trim()) {
    const parsed = Number.parseInt(code, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function readEnvelopeResult(body: unknown): unknown {
  const record = asRecord(body);
  return record.result ?? record.data ?? body;
}

export function readEnvelopeMessage(body: unknown): string | undefined {
  const record = asRecord(body);
  return readString(record.message)
    ?? readString(record.error)
    ?? readString(record.detail)
    ?? readString(asRecord(record.result).message);
}

export function isSuccessfulEnvelope(status: number, body: unknown): boolean {
  if (status >= 400) {
    return false;
  }

  const code = readEnvelopeCode(body);
  if (code === undefined) {
    return true;
  }

  return code === 0 || code === 200;
}

export function normalizeAddress(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

export function normalizeFilter(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

export function matchesAliasRecipient(
  recipients: string[],
  aliasAddress: string,
  accountEmail: string,
): boolean {
  const normalizedAccount = normalizeAddress(accountEmail);
  for (const recipient of recipients) {
    if (recipient === aliasAddress) {
      return true;
    }
    if (normalizedAccount && recipient === normalizedAccount) {
      return true;
    }
  }
  return false;
}

export function matchesSenderFilter(sender: string | undefined, fromContains: string | undefined): boolean {
  const normalizedFilter = normalizeFilter(fromContains);
  if (!normalizedFilter) {
    return true;
  }
  const normalizedSender = normalizeAddress(sender);
  if (!normalizedSender) {
    return false;
  }
  return normalizedSender.includes(normalizedFilter);
}

function readAddress(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized) {
      return undefined;
    }
    const match = normalized.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    return normalizeAddress(match?.[0] ?? normalized);
  }

  if (value && typeof value === "object" && Array.isArray(value) === false) {
    const record = value as Record<string, unknown>;
    return normalizeAddress(
      readString(record.emailAddress)
      ?? readString(record.address)
      ?? readString(record.mailAddress)
      ?? readString(record.email)
      ?? readString(record.mail)
      ?? readString(record.sender)
      ?? readString(record.senderAddress),
    );
  }

  return undefined;
}

function readAddressList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => readAddress(item))
      .filter((item): item is string => Boolean(item));
  }

  const single = readAddress(value);
  if (!single) {
    return [];
  }

  return [single];
}

export function readRecipients(record: Record<string, unknown>): string[] {
  const recipients = [
    record.mailTo,
    record.to,
    record.toAddress,
    record.mailReceivers,
    record.receivers,
    record.mailAddress,
  ].flatMap((value) => readAddressList(value));

  return [...new Set(recipients)];
}

export function readSender(record: Record<string, unknown>): string | undefined {
  return readAddress(record.mailFrom)
    ?? readAddress(record.from)
    ?? readAddress(record.sender)
    ?? normalizeAddress(readString(record.fromAddress))
    ?? normalizeAddress(readString(record.mailFromAddress));
}

export function readMessageId(record: Record<string, unknown>): string | undefined {
  return readString(record.MessageID)
    ?? readString(record.messageID)
    ?? readString(record.messageId)
    ?? readString(record.id)
    ?? readString(record.mailId);
}

export function readMessageTimestampMs(record: Record<string, unknown>): number {
  const raw = record.createTime ?? record.modifyDate ?? record.ReceiveTime ?? record.receiveTime;
  if (typeof raw === "number" && raw > 0) {
    return raw > 1e12 ? raw : raw * 1000;
  }
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed > 1e12 ? parsed : parsed * 1000;
    }
  }
  return 0;
}

export function readObservedAt(record: Record<string, unknown>): string | undefined {
  const direct = readString(record.ReceiveTime)
    ?? readString(record.receiveTime)
    ?? readString(record.receivedAt)
    ?? readString(record.received_at)
    ?? readString(record.SendDate)
    ?? readString(record.date);
  if (direct) {
    return direct;
  }

  // 2925 API uses createTime/modifyDate as epoch-millisecond timestamps.
  const epochMs = readMessageTimestampMs(record);
  if (epochMs > 0) {
    return new Date(epochMs).toISOString();
  }

  return undefined;
}

export function readMessageSubject(record: Record<string, unknown>): string | undefined {
  return readString(record.mailSubject)
    ?? readString(record.subject)
    ?? readString(record.title);
}

export function readMessageText(record: Record<string, unknown>): string | undefined {
  const raw = record.bodyText ?? record.textBody ?? record.bodyContent ?? record.text ?? record.content;
  if (Array.isArray(raw)) {
    const joined = raw.map((item) => String(item)).join("\n").trim();
    return joined || undefined;
  }
  return readString(raw);
}

export function readMessageHtml(record: Record<string, unknown>): string | undefined {
  const raw = record.bodyHtmlText ?? record.htmlBody ?? record.html ?? record.rawContent;
  if (Array.isArray(raw)) {
    const joined = raw.map((item) => String(item)).join("\n").trim();
    return joined || undefined;
  }
  return readString(raw);
}

export function extractMessageList(body: unknown): Record<string, unknown>[] {
  const envelopeResult = readEnvelopeResult(body);
  const directItems = asRecordList(envelopeResult);
  if (directItems.length > 0) {
    return directItems;
  }

  const result = asRecord(envelopeResult);
  const sources = [
    result.rows,
    result.list,
    result.items,
    result.mails,
    result.data,
    asRecord(result.data).rows,
    asRecord(result.data).list,
    asRecord(result.data).items,
  ];

  for (const source of sources) {
    const items = asRecordList(source);
    if (items.length > 0) {
      return items;
    }
  }

  return [];
}

export function extractFolderNames(body: unknown): string[] {
  const envelopeResult = readEnvelopeResult(body);
  const directItems = asRecordList(envelopeResult);
  if (directItems.length > 0) {
    return directItems
      .map((item) => readString(item.name) ?? readString(item.folderName) ?? readString(item.FolderName))
      .filter((item): item is string => Boolean(item));
  }

  const result = asRecord(envelopeResult);
  const sources = [result.rows, result.items, result.list, result.data];
  for (const source of sources) {
    const items = asRecordList(source);
    if (items.length === 0) {
      continue;
    }
    const names = items
      .map((item) => readString(item.name) ?? readString(item.folderName) ?? readString(item.FolderName))
      .filter((item): item is string => Boolean(item));
    if (names.length > 0) {
      return names;
    }
  }

  return [];
}

export function extractOtp(values: { subject?: string; textBody?: string; htmlBody?: string }) {
  return extractOtpFromContent(values);
}
