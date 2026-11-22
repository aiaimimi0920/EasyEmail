import type { MailImapMessageBody } from "../domain/mail-imap-sync.js";
import { decodeMimeHeaderWords } from "./mail-header-codec.js";

export interface ParsedMimeHeaders {
  subject?: string;
  from?: string;
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  date?: string;
  contentType: string;
  contentTransferEncoding: string;
  contentDisposition: string;
  listUnsubscribe?: string;
  listId?: string;
  precedence?: string;
}

function splitHeaderAndBody(raw: Buffer): { headerText: string; bodyBytes: Buffer } {
  const crlfIndex = raw.indexOf("\r\n\r\n");
  const lfIndex = raw.indexOf("\n\n");
  if (crlfIndex >= 0 && (lfIndex < 0 || crlfIndex <= lfIndex)) {
    return {
      headerText: raw.subarray(0, crlfIndex).toString("latin1"),
      bodyBytes: raw.subarray(crlfIndex + 4),
    };
  }
  if (lfIndex >= 0) {
    return {
      headerText: raw.subarray(0, lfIndex).toString("latin1"),
      bodyBytes: raw.subarray(lfIndex + 2),
    };
  }
  return {
    headerText: "",
    bodyBytes: raw,
  };
}

export function parseRawHeaderBlock(headerBlock: string | Buffer): Map<string, string[]> {
  const text = typeof headerBlock === "string" ? headerBlock : headerBlock.toString("latin1");
  const unfolded = text.replace(/\r?\n[ \t]+/gu, " ");
  const headers = new Map<string, string[]>();
  for (const line of unfolded.split(/\r?\n/u)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const existing = headers.get(key);
    if (existing) {
      existing.push(value);
    } else {
      headers.set(key, [value]);
    }
  }
  return headers;
}

function extractRfcMessageIds(rawValue: string | undefined): string[] {
  if (!rawValue) return [];
  const matches = rawValue.match(/<[^>]+>/gu);
  if (matches && matches.length > 0) {
    return matches.map((item) => item.trim()).filter(Boolean);
  }
  const single = rawValue.trim();
  return single ? [single] : [];
}

export function extractStructuredMimeHeaders(headerBlock: string | Buffer): ParsedMimeHeaders {
  const map = parseRawHeaderBlock(headerBlock);
  const first = (name: string): string | undefined => map.get(name)?.[0];
  const referencesRaw = map.get("references")?.join(" ");
  return {
    subject: first("subject") ? decodeMimeHeaderWords(first("subject")) : undefined,
    from: first("from") ? decodeMimeHeaderWords(first("from")) : undefined,
    messageId: extractRfcMessageIds(first("message-id"))[0],
    inReplyTo: extractRfcMessageIds(first("in-reply-to"))[0],
    references: [...new Set(extractRfcMessageIds(referencesRaw))],
    date: first("date"),
    contentType: first("content-type") ?? "text/plain; charset=utf-8",
    contentTransferEncoding: (first("content-transfer-encoding") ?? "7bit").trim().toLowerCase(),
    contentDisposition: (first("content-disposition") ?? "").trim().toLowerCase(),
    listUnsubscribe: first("list-unsubscribe"),
    listId: first("list-id"),
    precedence: first("precedence"),
  };
}

function parseMimeParam(headerValue: string, paramName: string): string | undefined {
  const regex = new RegExp(`${paramName}\\s*=\\s*(?:"([^"]+)"|([^;\\s]+))`, "iu");
  const matched = headerValue.match(regex);
  return (matched?.[1] ?? matched?.[2])?.trim();
}

function decodeQuotedPrintableBytes(input: Buffer): Buffer {
  const softStripped = input.toString("latin1").replace(/=\r?\n/gu, "");
  const bytes: number[] = [];
  for (let i = 0; i < softStripped.length; i += 1) {
    if (softStripped[i] === "=" && i + 2 < softStripped.length) {
      const hex = softStripped.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/u.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(softStripped.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes);
}

function decodeTransferEncoding(bodyBytes: Buffer, encoding: string): Buffer {
  if (encoding === "base64") {
    const cleaned = bodyBytes.toString("ascii").replace(/\s+/gu, "");
    return Buffer.from(cleaned, "base64");
  }
  if (encoding === "quoted-printable") {
    return decodeQuotedPrintableBytes(bodyBytes);
  }
  return bodyBytes;
}

function decodeCharsetBuffer(bytes: Buffer, rawCharset: string | undefined): string {
  const normalized = (rawCharset ?? "utf-8").trim().toLowerCase();
  const label = normalized === "utf8"
    ? "utf-8"
    : normalized === "gb2312" || normalized === "gbk"
      ? "gb18030"
      : normalized === "latin1" || normalized === "us-ascii" || normalized === "ascii"
        ? "windows-1252"
        : normalized;
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

function splitMultipartParts(bodyBytes: Buffer, boundary: string): Buffer[] {
  const rawLatin1 = bodyBytes.toString("latin1");
  const delimiter = `--${boundary}`;
  const segments = rawLatin1.split(delimiter);
  if (segments.length < 2) {
    return [];
  }
  const parts: Buffer[] = [];
  for (const segment of segments.slice(1)) {
    if (segment.startsWith("--")) {
      break;
    }
    const stripped = segment.replace(/^\r?\n/u, "").replace(/\r?\n$/u, "");
    if (stripped.length > 0) {
      parts.push(Buffer.from(stripped, "latin1"));
    }
  }
  return parts;
}

function stripHtmlTagsToPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/(?:p|div|li|tr|h[1-6])>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function parseImapRfc822MessageBody(rawSource: Buffer | string): MailImapMessageBody {
  const textParts: string[] = [];
  const htmlParts: string[] = [];
  let hasAttachments = false;

  const visitPart = (partBuffer: Buffer): void => {
    const { headerText, bodyBytes } = splitHeaderAndBody(partBuffer);
    const headers = extractStructuredMimeHeaders(headerText);
    const mediaType = headers.contentType.split(";")[0]?.trim().toLowerCase() ?? "text/plain";
    const dispositionType = headers.contentDisposition.split(";")[0]?.trim().toLowerCase() ?? "";

    if (mediaType.startsWith("multipart/")) {
      const boundary = parseMimeParam(headers.contentType, "boundary");
      if (boundary) {
        for (const child of splitMultipartParts(bodyBytes, boundary)) {
          visitPart(child);
        }
      }
      return;
    }

    const isAttachment =
      dispositionType === "attachment"
      || Boolean(parseMimeParam(headers.contentDisposition, "filename"))
      || (!mediaType.startsWith("text/") && dispositionType !== "inline");

    if (isAttachment && mediaType !== "text/plain" && mediaType !== "text/html") {
      hasAttachments = true;
      return;
    }
    if (dispositionType === "attachment") {
      hasAttachments = true;
      return;
    }

    const decodedBytes = decodeTransferEncoding(bodyBytes, headers.contentTransferEncoding);
    const decodedText = decodeCharsetBuffer(
      decodedBytes,
      parseMimeParam(headers.contentType, "charset"),
    );
    if (mediaType === "text/html") {
      htmlParts.push(decodedText);
    } else if (mediaType === "text/plain") {
      textParts.push(decodedText);
    }
  };

  visitPart(Buffer.isBuffer(rawSource) ? rawSource : Buffer.from(rawSource, "utf8"));

  const joinedHtml = htmlParts.join("\n").trim();
  const joinedText = textParts.join("\n").trim();
  return {
    bodyText: joinedText || (joinedHtml ? stripHtmlTagsToPlainText(joinedHtml) : ""),
    ...(joinedHtml ? { bodyHtml: joinedHtml } : {}),
    hasAttachments,
  };
}
