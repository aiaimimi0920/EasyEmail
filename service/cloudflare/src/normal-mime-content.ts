import PostalMime, { addressParser } from "postal-mime";
import { HttpError } from "./http";
import { mailAddress } from "./mail-address";
import { normalMimeHeaders } from "./normal-mime-headers";
import { IMAP_MESSAGE_BYTES } from "./normal-imap-fetch";
import type { MailContent, MailAttachment } from "./providers/contracts";

export type NormalMimeContent = Omit<MailContent, "remoteId" | "resourceVersion" | "remoteDeleteEnabled"> & { headerRecipient?: string };
export async function normalMimeHash(bytes: Uint8Array) {
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join("");
}
export async function parseNormalMimeParts(raw: Uint8Array) {
  if (!(raw instanceof Uint8Array) || !raw.length) throw new HttpError(502, "invalid_normal_message");
  if (raw.byteLength > IMAP_MESSAGE_BYTES) throw new HttpError(502, "normal_message_too_large");
  try {
    return await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer", maxNestingDepth: 32,
      maxHeadersSize: 256 * 1024, maxPartCount: 200, maxRfc822NestingDepth: 5, maxForwardedAddresses: 100 });
  } catch { throw new HttpError(502, "normal_mime_parse_failed"); }
}
export async function parseNormalMime(raw: Uint8Array, recipient: string, receivedAt: number, includeReplyEvidence = false, includeMailboxHeaders = false) {
  if (!mailAddress(recipient) || !Number.isSafeInteger(receivedAt) || Math.abs(receivedAt) > 8640000000000) throw new HttpError(502, "invalid_normal_message");
  const parsed = await parseNormalMimeParts(raw);
  const attachments: MailAttachment[] = [];
  for (const [index, part] of parsed.attachments.slice(0, 100).entries()) {
    if (typeof part.content === "string") throw new HttpError(502, "normal_mime_parse_failed");
    const bytes = part.content instanceof Uint8Array ? part.content : new Uint8Array(part.content);
    attachments.push({ index, filename: (part.filename ?? "").slice(0, 512), mimeType: part.mimeType.slice(0, 256),
      size: bytes.byteLength, sha256: await normalMimeHash(bytes) });
  }
  const from = parsed.from;
  const sender = from && !from.group ? (from.name ? `${from.name} <${from.address}>` : from.address) : "";
  const content: NormalMimeContent = {
    sender: sender.slice(0, 2048), recipient, subject: (parsed.subject ?? "").slice(0, 4096),
    textBody: (parsed.text ?? "").slice(0, 131072), htmlBody: (parsed.html ?? "").slice(0, 131072),
    attachments, attachmentsTruncated: parsed.attachments.length > 100, receivedAt, ...normalMimeHeaders(parsed.headers),
  };
  if (includeMailboxHeaders) content.headerRecipient = (parsed.to ?? []).flatMap(row => row.group ?? [row])
    .map(row => row.address).filter(Boolean).join(", ").slice(0, 320);
  const fromHeaders = includeReplyEvidence ? parsed.headers.filter(header => header.key.toLowerCase() === "from") : [];
  const authors = fromHeaders.length === 1 && fromHeaders[0].value.length <= 8192 ? addressParser(fromHeaders[0].value) : [];
  const author = authors.length === 1 && !authors[0].group ? authors[0] : null;
  const replyEvidence = includeReplyEvidence ? {
    from: author ? mailAddress(author.address)?.toLowerCase() ?? null : null,
    limited: ["from", "in-reply-to", "references"].some(key => parsed.headers.filter(header => header.key.toLowerCase() === key).length > 1),
  } : undefined;
  return { content, rawSha256: await normalMimeHash(raw), ...(includeReplyEvidence ? { replyEvidence } : {}) };
}
