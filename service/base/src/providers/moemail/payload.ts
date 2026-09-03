import { extractOtpFromContent } from "../../domain/otp.js";
import type {
  MoemailMailboxCredentials,
  MoemailMailboxListingEntry,
  MoemailMessageSummary,
} from "./types.js";

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
    return String(Math.trunc(value));
  }
  if (Array.isArray(value)) {
    const normalized = value.map((item) => String(item)).join("\n").trim();
    return normalized || undefined;
  }
  return undefined;
}

function normalizeFilter(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

export function matchesSenderFilter(
  sender: string | undefined,
  fromContains: string | undefined,
): boolean {
  const normalizedFilter = normalizeFilter(fromContains);
  if (!normalizedFilter) {
    return true;
  }
  const normalizedSender = readString(sender)?.toLowerCase();
  if (!normalizedSender) {
    return false;
  }
  return normalizedSender.includes(normalizedFilter);
}

export function extractOtp(values: {
  subject?: unknown;
  textBody?: unknown;
  htmlBody?: unknown;
}) {
  return extractOtpFromContent({
    subject: readString(values.subject),
    textBody: readString(values.textBody),
    htmlBody: readString(values.htmlBody),
  });
}

export function createLocalPartSeed(value: string | undefined): string {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 32);
  return normalized || `m${Math.random().toString(36).slice(2, 10)}`;
}

const CONFIG_DOMAIN_ROTATION_OFFSETS = new Map<string, number>();

export function nextConfigDomainRotationOffset(scope: string, domains: string[]): number {
  if (domains.length <= 1) {
    return 0;
  }

  const key = `${scope}:${domains.join(",")}`;
  const offset = CONFIG_DOMAIN_ROTATION_OFFSETS.get(key) ?? 0;
  CONFIG_DOMAIN_ROTATION_OFFSETS.set(key, (offset + 1) % domains.length);
  return offset;
}

export function normalizeEmailAddress(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) {
    return undefined;
  }
  return normalized;
}

export function splitEmailAddress(
  value: string | undefined,
): { email: string; localPart: string; domain: string } | undefined {
  const normalized = normalizeEmailAddress(value);
  if (!normalized) {
    return undefined;
  }
  const [localPart, domain] = normalized.split("@", 2);
  if (!localPart || !domain) {
    return undefined;
  }
  return {
    email: normalized,
    localPart,
    domain,
  };
}

export function toIsoTimestamp(value: unknown): string {
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 1_000_000_000_000 ? value : value * 1000;
    return new Date(millis).toISOString();
  }
  return "";
}

export function extractMailboxPayload(
  body: unknown,
  fallbackLocalPart?: string,
  fallbackDomain?: string,
): MoemailMailboxCredentials | undefined {
  const record = asRecord(body);
  const candidates = [
    record,
    asRecord(record.data),
    asRecord(record.email),
    asRecord(record.mailbox),
    asRecord(asRecord(record.data).email),
    asRecord(asRecord(record.data).mailbox),
    asRecord(asRecord(record.result).email),
    asRecord(asRecord(record.result).mailbox),
  ];

  for (const candidate of candidates) {
    const emailId = readString(candidate.emailId)
      ?? readString(candidate.id)
      ?? readString(candidate._id)
      ?? readString(candidate.mailboxId);
    const email = (readString(candidate.emailAddress)
      ?? readString(candidate.address)
      ?? readString(candidate.email)
      ?? readString(candidate.mailbox))?.toLowerCase();
    const localPart = readString(candidate.name)
      ?? readString(candidate.localPart)
      ?? email?.split("@", 1)[0]
      ?? fallbackLocalPart;
    const domain = readString(candidate.domain)
      ?? email?.split("@").slice(1).join("@")
      ?? fallbackDomain;

    if (emailId && (email || (localPart && domain))) {
      const resolvedEmail = email ?? `${localPart!}@${domain!}`.toLowerCase();
      if (!resolvedEmail.includes("@")) {
        continue;
      }
      return {
        emailId,
        email: resolvedEmail,
        localPart,
        domain,
      };
    }
  }

  return undefined;
}

export function extractMailboxListingEntries(
  body: unknown,
): { emails: MoemailMailboxListingEntry[]; nextCursor?: string; total?: number } {
  const record = asRecord(body);
  const payloads = [record, asRecord(record.data), asRecord(record.result)];

  for (const payload of payloads) {
    const items = asRecordList(payload.emails ?? payload.items ?? payload.list);
    if (items.length <= 0) {
      continue;
    }

    const emails: MoemailMailboxListingEntry[] = [];
    for (const item of items) {
      const emailId = readString(item.id)
        ?? readString(item.emailId)
        ?? readString(item._id)
        ?? readString(item.mailboxId);
      const email = (
        readString(item.address)
        ?? readString(item.email)
        ?? readString(item.emailAddress)
        ?? readString(item.mailbox)
      )?.toLowerCase();
      if (!emailId || !email) {
        continue;
      }
      emails.push({
        emailId,
        email,
        createdAt: readString(item.createdAt) ?? readString(item.created_at),
        expiresAt: readString(item.expiresAt) ?? readString(item.expires_at),
      });
    }

    return {
      emails,
      nextCursor: readString(payload.nextCursor) ?? readString(payload.cursor),
      total: Number.isFinite(Number(payload.total)) ? Number(payload.total) : undefined,
    };
  }

  return {
    emails: [],
    nextCursor: readString(record.nextCursor) ?? readString(record.cursor),
    total: Number.isFinite(Number(record.total)) ? Number(record.total) : undefined,
  };
}

export function extractMessageEntries(
  body: unknown,
): { items: Record<string, unknown>[]; nextCursor?: string } {
  const record = asRecord(body);
  const payload = [record, asRecord(record.data), asRecord(record.result)];

  for (const candidate of payload) {
    const items = asRecordList(candidate.messages ?? candidate.items ?? candidate.list);
    if (items.length > 0) {
      return {
        items,
        nextCursor: readString(candidate.nextCursor) ?? readString(candidate.cursor),
      };
    }
  }

  return {
    items: [],
    nextCursor: readString(record.nextCursor) ?? readString(record.cursor),
  };
}

function readMessageId(record: Record<string, unknown>): string | undefined {
  return readString(record.messageId)
    ?? readString(record.id)
    ?? readString(record._id)
    ?? readString(record.mailId);
}

export function readMessageSender(record: Record<string, unknown>): string | undefined {
  const from = record.from;
  if (from && typeof from === "object" && Array.isArray(from) === false) {
    return readString((from as Record<string, unknown>).address)
      ?? readString((from as Record<string, unknown>).email)
      ?? readString((from as Record<string, unknown>).name)
      ?? readString((from as Record<string, unknown>).from);
  }
  return readString(record.from)
    ?? readString(record.sender)
    ?? readString(record.fromAddress)
    ?? readString(record.senderAddress)
    ?? readString(record.from_address)
    ?? readString(record.sender_address);
}

export function readMessageSubject(record: Record<string, unknown>): string | undefined {
  return readString(record.subject) ?? readString(record.title);
}

export function readMessageText(record: Record<string, unknown>): string | undefined {
  return readString(record.text)
    ?? readString(record.textBody)
    ?? readString(record.body)
    ?? readString(record.content)
    ?? readString(record.preview)
    ?? readString(record.snippet)
    ?? readString(record.summary);
}

export function readMessageHtml(record: Record<string, unknown>): string | undefined {
  return readString(record.html)
    ?? readString(record.htmlBody)
    ?? readString(record.htmlContent)
    ?? readString(record.rawHtml);
}

export function deriveTextBodyFromHtml(htmlBody: string | undefined): string | undefined {
  const html = readString(htmlBody);
  if (!html) {
    return undefined;
  }

  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();

  return text || undefined;
}

export function summarizeMessage(
  record: Record<string, unknown>,
): MoemailMessageSummary | undefined {
  const messageId = readMessageId(record);
  if (!messageId) {
    return undefined;
  }
  const htmlBody = readMessageHtml(record);
  const textBody = readMessageText(record) ?? deriveTextBodyFromHtml(htmlBody);
  return {
    messageId,
    sender: readMessageSender(record),
    subject: readMessageSubject(record),
    textBody,
    htmlBody,
    observedAt: toIsoTimestamp(
      record.received_at
      ?? record.receivedAt
      ?? record.sent_at
      ?? record.createdAt
      ?? record.created_at
      ?? record.updatedAt
      ?? record.updated_at
      ?? record.timestamp,
    ),
  };
}

export function extractDomainsFromConfig(config: Record<string, unknown>): string[] {
  const roots = [config, asRecord(config.data), asRecord(config.result)];
  for (const root of roots) {
    const csvField = readString(root.emailDomains) ?? readString(root.email_domains);
    if (csvField) {
      const domains = csvField
        .split(/[\s,;]+/)
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
      if (domains.length > 0) {
        return [...new Set(domains)];
      }
    }
    const objectList = asRecordList(root.domains);
    const domains = objectList
      .map((item) => readString(item.domain) ?? readString(item.name))
      .filter((item): item is string => Boolean(item));
    if (domains.length > 0) {
      return [...new Set(domains.map((item) => item.trim().toLowerCase()))];
    }
  }
  return [];
}
