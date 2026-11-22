import { Buffer } from "node:buffer";

const ENCODED_WORD_RE = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;
const ADJACENT_ENCODED_WORD_WHITESPACE_RE = /(\?=)\s+(=\?)/g;

function decodeQuotedPrintableWord(encoded: string, encoding: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < encoded.length; index += 1) {
    const ch = encoded[index]!;
    if (ch === "_") {
      bytes.push(0x20);
      continue;
    }
    const hex = encoded.slice(index + 1, index + 3);
    if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }
    bytes.push(ch.charCodeAt(0) & 0xff);
  }
  return decodeBytesWithCharset(Buffer.from(bytes), encoding);
}

function decodeBytesWithCharset(buffer: Buffer, rawCharset: string): string {
  const charset = rawCharset.trim().toLowerCase();
  if (charset === "utf-8" || charset === "utf8" || charset === "us-ascii" || charset === "ascii") {
    return buffer.toString("utf8");
  }
  if (charset === "iso-8859-1" || charset === "latin1") {
    return buffer.toString("latin1");
  }
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return buffer.toString("utf8");
  }
}

export function decodeMimeHeaderWords(rawValue: string | undefined): string {
  if (!rawValue) {
    return "";
  }
  const collapsed = rawValue
    .replace(/\r?\n[ \t]+/g, " ")
    .replace(ADJACENT_ENCODED_WORD_WHITESPACE_RE, "$1$2");

  const decoded = collapsed.replace(
    ENCODED_WORD_RE,
    (fullMatch, rawCharset: string, mode: string, payload: string) => {
      try {
        if (mode.toUpperCase() === "B") {
          return decodeBytesWithCharset(Buffer.from(payload, "base64"), rawCharset);
        }
        return decodeQuotedPrintableWord(payload, rawCharset);
      } catch {
        return fullMatch;
      }
    },
  );

  return decoded.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/g, " ").trim();
}

export function parseSenderHeader(rawSender: string | undefined): {
  fromAddress: string;
  fromName?: string;
} {
  const decoded = decodeMimeHeaderWords(rawSender);
  if (!decoded) {
    return { fromAddress: "" };
  }
  const angleMatch = decoded.match(/^(.*?)<\s*([^<>@\s]+@[^<>@\s]+)\s*>\s*$/u);
  if (angleMatch) {
    const rawName = (angleMatch[1] ?? "").trim().replace(/^["']+|["']+$/g, "").trim();
    const address = (angleMatch[2] ?? "").trim();
    return {
      fromAddress: decoded,
      ...(rawName ? { fromName: rawName } : address ? {} : {}),
    };
  }
  return { fromAddress: decoded };
}
