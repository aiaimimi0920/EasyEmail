import {
  asRecord,
  asRecordList,
  isIm215DomainUsable,
  normalizeDomain,
  readSender,
  readString,
} from "./protocol-values.js";

export interface Im215MailboxRefPayload {
  address: string;
  mailboxId?: string;
  domain?: string;
  createdAt?: string;
  tempToken?: string;
}

export function extractDomainCandidates(body: unknown): string[] {
  const record = asRecord(body);
  const sources = [
    body,
    record.data,
    record.items,
    record.domains,
    record.list,
    asRecord(record.data).items,
    asRecord(record.data).domains,
    asRecord(record.result).items,
    asRecord(record.result).domains,
  ];

  const seen = new Set<string>();
  for (const source of sources) {
    const items = Array.isArray(source)
      ? source
      : asRecordList(source);
    for (const item of items) {
      if (typeof item === "string") {
        const domain = normalizeDomain(item);
        if (domain) {
          seen.add(domain);
        }
        continue;
      }
      const itemRecord = item as Record<string, unknown>;
      const domain = normalizeDomain(readString(itemRecord.domain)
        ?? readString(itemRecord.name)
        ?? readString(itemRecord.value)
        ?? readString(itemRecord.domainName));
      if (domain && isIm215DomainUsable(itemRecord)) {
        seen.add(domain);
      }
    }
  }

  return [...seen];
}

export function extractMailboxPayload(body: unknown): Im215MailboxRefPayload | undefined {
  const record = asRecord(body);
  const nested = [
    record,
    asRecord(record.data),
    asRecord(record.account),
    asRecord(record.mailbox),
    asRecord(record.result),
    asRecord(asRecord(record.data).account),
    asRecord(asRecord(record.data).mailbox),
  ];

  for (const candidate of nested) {
    const address = readString(candidate.address)
      ?? readString(candidate.email)
      ?? readString(candidate.mailbox)
      ?? readString(candidate.username);
    if (!address || !address.includes("@")) {
      continue;
    }
    return {
      address: address.trim().toLowerCase(),
      mailboxId: readString(candidate.id) ?? readString(candidate.accountId) ?? readString(candidate.mailboxId),
      domain: readString(candidate.domain),
      createdAt: readString(candidate.createdAt) ?? readString(candidate.created_at),
      tempToken: readString(candidate.token) ?? readString(candidate.tempToken),
    };
  }

  return undefined;
}

export function extractMessageList(body: unknown): Record<string, unknown>[] {
  const record = asRecord(body);
  const sources = [
    body,
    record.data,
    record.items,
    record.messages,
    record.list,
    asRecord(record.data).items,
    asRecord(record.data).messages,
    asRecord(record.result).items,
    asRecord(record.result).messages,
  ];

  for (const source of sources) {
    const items = asRecordList(source);
    if (items.length > 0) {
      return items;
    }
  }

  return [];
}

export function readMessageId(record: Record<string, unknown>): string | undefined {
  return readString(record.id)
    ?? readString(record.messageId)
    ?? readString(record.mailId)
    ?? readString(record.uuid)
    ?? readString(record._id);
}

export function readObservedAt(record: Record<string, unknown>): string | undefined {
  return readString(record.createdAt)
    ?? readString(record.created_at)
    ?? readString(record.receivedAt)
    ?? readString(record.received_at)
    ?? readString(record.date)
    ?? readString(record.time);
}

export function readMessageSubject(record: Record<string, unknown>): string | undefined {
  return readString(record.subject) ?? readString(record.title);
}

export function readMessageSender(record: Record<string, unknown>): string | undefined {
  return readSender(record.from)
    ?? readSender(record.sender)
    ?? readString(record.from_address)
    ?? readString(record.mailFrom);
}

export function readMessageText(record: Record<string, unknown>): string | undefined {
  return readString(record.text)
    ?? readString(record.textBody)
    ?? readString(record.body)
    ?? readString(record.content)
    ?? readString(record.snippet)
    ?? readString(record.preview)
    ?? readString(record.intro);
}

export function readMessageHtml(record: Record<string, unknown>): string | undefined {
  return readString(record.html)
    ?? readString(record.htmlBody)
    ?? readString(record.html_content)
    ?? readString(record.raw_content);
}
