import { decodeMailHeaderTextWithFallback } from "../domain/mail-charset-fallback.js";

export function decodeMimeHeaderWords(
  rawValue: string | undefined,
  hintCharset?: string,
): string {
  if (!rawValue) {
    return "";
  }
  return decodeMailHeaderTextWithFallback(rawValue, hintCharset);
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
