import type { MailAttachment } from "./providers/contracts";

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export function downloadable(item: MailAttachment): boolean {
  return Number.isSafeInteger(item.index) && item.index! >= 0 && item.index! < 100
    && typeof item.sha256 === "string" && /^[0-9a-f]{64}$/.test(item.sha256)
    && Number.isSafeInteger(item.size) && item.size >= 0 && item.size <= MAX_ATTACHMENT_BYTES;
}

export function attachmentFilename(value: string): string {
  const safe = Array.from(value, (character) => /^[\ud800-\udfff]$/u.test(character) ? "_" : character);
  const name = safe.slice(0, 120).join("").replace(/[\p{Cc}\p{Cf}<>:"/\\|?*]/gu, "_").replace(/[. ]+$/, "");
  return !name || /^\.+$/.test(name) ? "attachment.bin"
    : /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? `attachment-${name}` : name;
}

export function attachmentDisposition(filename: string): string {
  const encoded = encodeURIComponent(attachmentFilename(filename)).replace(/[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="attachment.bin"; filename*=UTF-8''${encoded}`;
}
