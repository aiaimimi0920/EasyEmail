import type { Env } from "./contracts";
import { HttpError } from "./http";
import { normalMimeHash, type NormalMimeContent } from "./normal-mime-content";
import type { NormalStoredMessage } from "./normal-inbox-access";
import { downloadable } from "./attachment-policy";

export async function normalObject(env: Env, key: string, size: number, digest: string) {
  if (!env.INBOX) throw new HttpError(503, "normal_inbox_not_configured");
  if (!Number.isInteger(size) || size < 1 || size > 2097152 || !/^[0-9a-f]{64}$/.test(digest)) throw new HttpError(503, "normal_content_unavailable");
  try {
    const object = await env.INBOX.get(key);
    if (!object || object.size !== size) throw new Error("invalid object metadata");
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.length !== size || await normalMimeHash(bytes) !== digest) throw new Error("invalid object digest");
    return bytes;
  } catch { throw new HttpError(503, "normal_content_unavailable"); }
}
export function normalSummary(value: unknown): { sender: string; recipient: string; subject: string } {
  if (!value || typeof value !== "object") throw new HttpError(503, "normal_content_unavailable");
  const item = value as Record<string, unknown>;
  for (const [key, max] of [["sender", 2048], ["recipient", 320], ["subject", 4096]] as const) {
    if (typeof item[key] !== "string" || item[key].length > max) throw new HttpError(503, "normal_content_unavailable");
  }
  return { sender: item.sender as string, recipient: item.recipient as string, subject: item.subject as string };
}
export async function normalContent(env: Env, row: Pick<NormalStoredMessage, "content_key" | "content_bytes" | "content_sha256" | "received_at">): Promise<NormalMimeContent> {
  const bytes = await normalObject(env, row.content_key, row.content_bytes, row.content_sha256);
  try {
    const content = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as NormalMimeContent;
    normalSummary(content);
    if (typeof content.textBody !== "string" || content.textBody.length > 131072 || typeof content.htmlBody !== "string"
      || content.htmlBody.length > 131072 || content.receivedAt !== row.received_at || !Array.isArray(content.attachments)
      || content.attachments.length > 100 || typeof content.attachmentsTruncated !== "boolean"
      || (content.headerRecipient !== undefined && (typeof content.headerRecipient !== "string" || content.headerRecipient.length > 320))
      || content.attachments.some((part, index) => !part || part.index !== index || !downloadable(part)
        || typeof part.filename !== "string" || part.filename.length > 512 || typeof part.mimeType !== "string")) throw new Error("invalid content");
    return content;
  } catch { throw new HttpError(503, "normal_content_unavailable"); }
}
