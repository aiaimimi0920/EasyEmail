const UTF8_DECODER_STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const UTF8_DECODER_LOSSY = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });
const UTF8_ENCODER = new TextEncoder();

const ENCODED_WORD_RE = /=\?([^?\s]+)\?([BbQq])\?([^?]*)\?=/g;
const ADJACENT_ENCODED_WORD_WS_RE = /(\?=)[ \t\r\n]+(=\?)/g;
const HEADER_CHARSET_HINT_RE = /charset\s*=\s*"?([A-Za-z0-9._-]+)"?/i;

export function normalizeMailCharsetLabel(rawLabel: string | undefined | null): string {
  const norm = (rawLabel ?? "").trim().toLowerCase();
  if (!norm) return "";
  switch (norm) {
    case "utf-8":
    case "utf8":
    case "unicode-1-1-utf-8":
      return "utf-8";
    case "us-ascii":
    case "ascii":
    case "ansi_x3.4-1968":
      return "utf-8";
    case "gb18030":
    case "gbk":
    case "gb2312":
    case "gb_2312":
    case "gb_2312-80":
    case "x-gbk":
    case "chinese":
    case "csgb2312":
    case "cn-gb":
    case "ms936":
    case "cp936":
    case "windows-936":
      return "gb18030";
    case "big5":
    case "big5-hkscs":
    case "cn-big5":
    case "csbig5":
    case "x-x-big5":
    case "cp950":
      return "big5";
    case "euc-kr":
    case "cseuckr":
    case "ks_c_5601-1987":
    case "ks_c_5601-1989":
    case "ks_c_5601":
    case "ksc5601":
    case "ksc_5601":
    case "cp949":
    case "uhc":
    case "korean":
      return "euc-kr";
    case "shift_jis":
    case "shift-jis":
    case "sjis":
    case "x-sjis":
    case "ms_kanji":
    case "csshiftjis":
    case "windows-31j":
    case "cp932":
      return "shift_jis";
    case "euc-jp":
    case "cseucpkdfmtjapanese":
    case "x-euc-jp":
      return "euc-jp";
    case "iso-2022-jp":
    case "csiso2022jp":
      return "iso-2022-jp";
    case "koi8-r":
    case "cskoi8r":
      return "koi8-r";
    case "windows-1251":
    case "cp1251":
      return "windows-1251";
    case "iso-8859-1":
    case "latin1":
    case "latin-1":
    case "cp1252":
    case "windows-1252":
      return "windows-1252";
    default:
      return norm;
  }
}

export function tryDecodeBytesWithCharset(
  bytes: Uint8Array,
  rawCharset: string,
  rejectReplacement = true,
): string | undefined {
  const canonical = normalizeMailCharsetLabel(rawCharset);
  if (!canonical) return undefined;
  try {
    const decoder = new TextDecoder(canonical, { fatal: rejectReplacement, ignoreBOM: false });
    const decoded = decoder.decode(bytes);
    if (rejectReplacement && decoded.includes("\uFFFD")) {
      return undefined;
    }
    return decoded;
  } catch {
    return undefined;
  }
}

export function decodeMailBytesWithFallback(bytes: Uint8Array, hintCharset?: string): string {
  if (bytes.byteLength === 0) return "";
  try {
    return UTF8_DECODER_STRICT.decode(bytes);
  } catch {
    // Non-UTF-8 raw bytes: attempt lossless hint charset first, then lossless GB18030.
  }
  const normalizedHint = normalizeMailCharsetLabel(hintCharset);
  if (normalizedHint && normalizedHint !== "utf-8") {
    const hintedStrict = tryDecodeBytesWithCharset(bytes, normalizedHint, true);
    if (hintedStrict !== undefined) return hintedStrict;
  }
  const gbStrict = tryDecodeBytesWithCharset(bytes, "gb18030", true);
  if (gbStrict !== undefined) return gbStrict;
  if (normalizedHint && normalizedHint !== "utf-8") {
    const hintedLossy = tryDecodeBytesWithCharset(bytes, normalizedHint, false);
    if (hintedLossy !== undefined) return hintedLossy;
  }
  const gbLossy = tryDecodeBytesWithCharset(bytes, "gb18030", false);
  if (gbLossy !== undefined) return gbLossy;
  return UTF8_DECODER_LOSSY.decode(bytes);
}

function decodeBase64PayloadToBytes(payload: string): Uint8Array {
  const cleaned = payload.replace(/[^A-Za-z0-9+/=]/g, "");
  if (!cleaned) return new Uint8Array(0);
  const padded = cleaned.length % 4 === 0 ? cleaned : cleaned.padEnd(cleaned.length + (4 - (cleaned.length % 4)), "=");
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    out[index] = binary.charCodeAt(index) & 0xff;
  }
  return out;
}

function decodeQuotedPrintableWordToBytes(payload: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < payload.length; index += 1) {
    const ch = payload[index]!;
    if (ch === "_") {
      bytes.push(0x20);
      continue;
    }
    const hex = payload.slice(index + 1, index + 3);
    if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }
    bytes.push(ch.charCodeAt(0) & 0xff);
  }
  return Uint8Array.from(bytes);
}

function latin1StringHasRawHighBytes(value: string): boolean {
  let hasHigh = false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code > 0xff) return false;
    if (code >= 0x80) hasHigh = true;
  }
  return hasHigh;
}

export function decodeMailHeaderTextWithFallback(
  rawInput: string | Uint8Array | undefined | null,
  hintCharset?: string,
): string {
  if (!rawInput) return "";
  let text: string;
  if (rawInput instanceof Uint8Array) {
    text = decodeMailBytesWithFallback(rawInput, hintCharset);
  } else if (latin1StringHasRawHighBytes(rawInput)) {
    const rawBytes = new Uint8Array(rawInput.length);
    for (let i = 0; i < rawInput.length; i += 1) rawBytes[i] = rawInput.charCodeAt(i) & 0xff;
    text = decodeMailBytesWithFallback(rawBytes, hintCharset);
  } else {
    text = rawInput;
  }

  const collapsed = text
    .replace(/\r?\n[ \t]+/g, " ")
    .replace(ADJACENT_ENCODED_WORD_WS_RE, "$1$2");

  const decoded = collapsed.replace(
    ENCODED_WORD_RE,
    (fullMatch, rawCharset: string, mode: string, payload: string) => {
      try {
        const bytes = mode.toUpperCase() === "B"
          ? decodeBase64PayloadToBytes(payload)
          : decodeQuotedPrintableWordToBytes(payload);
        const byDeclared = tryDecodeBytesWithCharset(bytes, rawCharset, true)
          ?? tryDecodeBytesWithCharset(bytes, rawCharset, false);
        return byDeclared ?? decodeMailBytesWithFallback(bytes, hintCharset);
      } catch {
        return fullMatch;
      }
    },
  );

  return decoded.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

function findHeaderBodySplitOffset(rawMime: Uint8Array): { headerEnd: number; separatorLength: number } {
  for (let i = 0; i < rawMime.byteLength - 1; i += 1) {
    if (rawMime[i] === 0x0d && rawMime[i + 1] === 0x0a && rawMime[i + 2] === 0x0d && rawMime[i + 3] === 0x0a) {
      return { headerEnd: i, separatorLength: 4 };
    }
    if (rawMime[i] === 0x0a && rawMime[i + 1] === 0x0a) {
      return { headerEnd: i, separatorLength: 2 };
    }
  }
  return { headerEnd: rawMime.byteLength, separatorLength: 0 };
}

export function repairRawMimeHeaderCharsetBytes(rawMime: Uint8Array): Uint8Array {
  if (rawMime.byteLength === 0) return rawMime;
  const { headerEnd, separatorLength } = findHeaderBodySplitOffset(rawMime);
  const headerBytes = rawMime.subarray(0, headerEnd);
  let hasHighByte = false;
  for (let i = 0; i < headerBytes.byteLength; i += 1) {
    if (headerBytes[i]! >= 0x80) {
      hasHighByte = true;
      break;
    }
  }
  if (!hasHighByte) return rawMime;
  try {
    UTF8_DECODER_STRICT.decode(headerBytes);
    return rawMime;
  } catch {
    // Bare non-UTF-8 8-bit header bytes found (e.g. unencoded GB18030 Subject/From).
  }
  const previewWindow = rawMime.subarray(0, Math.min(rawMime.byteLength, headerEnd + 4096));
  const asciiPreview = UTF8_DECODER_LOSSY.decode(previewWindow);
  const hint = HEADER_CHARSET_HINT_RE.exec(asciiPreview)?.[1];
  const repairedHeaderText = decodeMailBytesWithFallback(headerBytes, hint);
  const repairedHeaderBytes = UTF8_ENCODER.encode(repairedHeaderText);
  const tail = rawMime.subarray(headerEnd);
  const combined = new Uint8Array(repairedHeaderBytes.byteLength + tail.byteLength);
  combined.set(repairedHeaderBytes, 0);
  combined.set(tail, repairedHeaderBytes.byteLength);
  void separatorLength;
  return combined;
}
