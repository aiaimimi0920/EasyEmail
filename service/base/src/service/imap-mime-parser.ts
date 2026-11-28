import type { MailImapMessageBody } from "../domain/mail-imap-sync.js";
import {
  decodeMailBytesWithFallback,
  normalizeMailCharsetLabel,
  tryDecodeBytesWithCharset,
} from "../domain/mail-charset-fallback.js";
import { normalizeMailContentId } from "../domain/mail-safe-html-engine.js";
import { decodeMimeHeaderWords } from "./mail-header-codec.js";

const MAX_INLINE_CID_IMAGE_BYTES = 512 * 1024;
const MAX_TOTAL_INLINE_CID_BYTES = 1_500_000;
const INLINE_RASTER_MIME_TYPES: Readonly<Record<string, string>> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/gif": "image/gif",
  "image/webp": "image/webp",
};

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
  contentId?: string;
  listUnsubscribe?: string;
  listId?: string;
  precedence?: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function decodePercentBytes(encoded: string, charset: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i += 1) {
    const ch = encoded[i]!;
    const hex = encoded.slice(i + 1, i + 3);
    if (ch === "%" && /^[0-9A-Fa-f]{2}$/u.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
      continue;
    }
    bytes.push(ch.charCodeAt(0) & 0xff);
  }
  return decodeMailBytesWithFallback(Uint8Array.from(bytes), charset);
}

function parseRfc2231Param(headerValue: string, paramName: string): string | undefined {
  const escaped = escapeRegExp(paramName);
  const directRe = new RegExp(`(?:^|[;\\s])${escaped}\\*\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "iu");
  const direct = directRe.exec(headerValue);
  if (direct) {
    const raw = (direct[1] ?? direct[2] ?? "").trim();
    const parts = /^([^']*)'[^']*'(.*)$/u.exec(raw);
    if (parts) return decodePercentBytes(parts[2] ?? "", parts[1] || "utf-8");
    return decodePercentBytes(raw, "utf-8");
  }

  const contRe = new RegExp(`(?:^|[;\\s])${escaped}\\*(\\d+)(\\*?)\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^;\\s]+))`, "giu");
  const chunks: Array<{ index: number; encoded: boolean; value: string }> = [];
  for (const m of headerValue.matchAll(contRe)) {
    chunks.push({
      index: Number.parseInt(m[1]!, 10),
      encoded: m[2] === "*",
      value: (m[3] ?? m[4] ?? m[5] ?? "").trim(),
    });
  }
  if (chunks.length === 0) return undefined;
  chunks.sort((a, b) => a.index - b.index);
  let charset = "utf-8";
  let combined = "";
  for (const chunk of chunks) {
    if (chunk.index === 0 && chunk.encoded) {
      const m = /^([^']*)'[^']*'(.*)$/u.exec(chunk.value);
      if (m) {
        charset = m[1] || "utf-8";
        combined += m[2] ?? "";
        continue;
      }
    }
    combined += chunk.value;
  }
  return chunks.some((c) => c.encoded) ? decodePercentBytes(combined, charset) : combined;
}

function parseMimeParam(headerValue: string, paramName: string): string | undefined {
  const extValue = parseRfc2231Param(headerValue, paramName);
  if (extValue) {
    return extValue.trim();
  }
  const escaped = escapeRegExp(paramName);
  const regex = new RegExp(`(?:^|[;\\s])${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^;\\s]+))`, "iu");
  const matched = headerValue.match(regex);
  const raw = (matched?.[1] ?? matched?.[2] ?? matched?.[3])?.trim();
  if (!raw) return undefined;
  return raw.includes("=?") ? decodeMimeHeaderWords(raw) : raw;
}

export function extractStructuredMimeHeaders(headerBlock: string | Buffer): ParsedMimeHeaders {
  const map = parseRawHeaderBlock(headerBlock);
  const first = (name: string): string | undefined => map.get(name)?.[0];
  const referencesRaw = map.get("references")?.join(" ");
  const contentType = first("content-type") ?? "text/plain; charset=utf-8";
  const charsetHint = parseMimeParam(contentType, "charset");
  return {
    subject: first("subject") ? decodeMimeHeaderWords(first("subject"), charsetHint) : undefined,
    from: first("from") ? decodeMimeHeaderWords(first("from"), charsetHint) : undefined,
    messageId: extractRfcMessageIds(first("message-id"))[0],
    inReplyTo: extractRfcMessageIds(first("in-reply-to"))[0],
    references: [...new Set(extractRfcMessageIds(referencesRaw))],
    date: first("date"),
    contentType,
    contentTransferEncoding: (first("content-transfer-encoding") ?? "7bit").trim().toLowerCase(),
    contentDisposition: (first("content-disposition") ?? "").trim().toLowerCase(),
    contentId: first("content-id"),
    listUnsubscribe: first("list-unsubscribe"),
    listId: first("list-id"),
    precedence: first("precedence"),
  };
}

function decodeQuotedPrintableBytes(input: Buffer): Buffer {
  const softStripped = input.toString("latin1").replace(/=[ \t]*\r?\n/gu, "");
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
  const uint8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (rawCharset?.trim()) {
    const normalized = normalizeMailCharsetLabel(rawCharset);
    const decoded = tryDecodeBytesWithCharset(uint8, normalized, false);
    if (decoded !== undefined) return decoded;
  }
  return decodeMailBytesWithFallback(uint8, rawCharset);
}

function splitMultipartParts(bodyBytes: Buffer, boundary: string): Buffer[] {
  const rawLatin1 = bodyBytes.toString("latin1");
  const delimiterRe = new RegExp(`(?:^|\\r?\\n)--${escapeRegExp(boundary)}(--)?[ \\t]*(?=\\r?\\n|$)`, "g");
  const matches = [...rawLatin1.matchAll(delimiterRe)];
  if (matches.length === 0) {
    return [];
  }
  const parts: Buffer[] = [];
  for (let i = 0; i < matches.length; i += 1) {
    const current = matches[i]!;
    if (current[1] === "--") {
      break;
    }
    const contentStart = current.index! + current[0].length;
    const next = matches[i + 1];
    const contentEnd = next ? next.index! : rawLatin1.length;
    const segment = rawLatin1.slice(contentStart, contentEnd).replace(/^\r?\n/u, "").replace(/\r?\n$/u, "");
    if (segment.length > 0) {
      parts.push(Buffer.from(segment, "latin1"));
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
  const calendarParts: string[] = [];
  const inlineCidDataUrls: Record<string, string> = {};
  let totalInlineCidBytes = 0;
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

    const explicitFilename = Boolean(
      parseMimeParam(headers.contentDisposition, "filename")
      || parseMimeParam(headers.contentType, "name"),
    );
    const inlineMime = INLINE_RASTER_MIME_TYPES[mediaType];
    const normalizedCid = headers.contentId ? normalizeMailContentId(headers.contentId) : "";
    if (inlineMime && normalizedCid && dispositionType !== "attachment") {
      const decodedBytes = decodeTransferEncoding(bodyBytes, headers.contentTransferEncoding);
      if (
        decodedBytes.byteLength > 0
        && decodedBytes.byteLength <= MAX_INLINE_CID_IMAGE_BYTES
        && totalInlineCidBytes + decodedBytes.byteLength <= MAX_TOTAL_INLINE_CID_BYTES
      ) {
        inlineCidDataUrls[normalizedCid] = `data:${inlineMime};base64,${decodedBytes.toString("base64")}`;
        totalInlineCidBytes += decodedBytes.byteLength;
      }
      return;
    }

    const isAttachment =
      dispositionType === "attachment"
      || explicitFilename
      || (!mediaType.startsWith("text/") && dispositionType !== "inline");

    if (mediaType === "text/calendar") {
      if (dispositionType === "attachment" || explicitFilename) {
        hasAttachments = true;
      }
      const decodedBytes = decodeTransferEncoding(bodyBytes, headers.contentTransferEncoding);
      const decodedCalendar = decodeCharsetBuffer(decodedBytes, parseMimeParam(headers.contentType, "charset")).trim();
      if (decodedCalendar) {
        calendarParts.push(decodedCalendar);
      }
      return;
    }

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
  const joinedCalendar = calendarParts.join("\n").trim();
  const baseText = joinedText || (joinedHtml ? stripHtmlTagsToPlainText(joinedHtml) : "");
  const bodyText = joinedCalendar && !baseText.includes("BEGIN:VCALENDAR")
    ? (baseText ? `${baseText}\n\n${joinedCalendar}` : joinedCalendar)
    : baseText;
  return {
    bodyText,
    ...(joinedHtml ? { bodyHtml: joinedHtml } : {}),
    hasAttachments,
    ...(Object.keys(inlineCidDataUrls).length > 0 ? { inlineCidDataUrls } : {}),
  };
}
