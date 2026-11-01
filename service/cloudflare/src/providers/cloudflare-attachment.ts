import PostalMime from "postal-mime";
import { MAX_ATTACHMENT_BYTES } from "../attachment-policy";
import { HttpError } from "../http";
import type { MailAttachment, MailCredential, ProviderConfig, ProviderSecret } from "./contracts";
import { object, providerJson, remoteId, string } from "./http";

export async function cloudflareAttachment(config: ProviderConfig, secret: ProviderSecret, signal: AbortSignal,
  address: string, credential: MailCredential, id: string, expected: MailAttachment): Promise<Uint8Array<ArrayBuffer>> {
  if (!credential.token) throw new HttpError(503, "mailbox_credential_unavailable");
  const headers: Record<string, string> = { authorization: `Bearer ${credential.token}` };
  if (secret.sitePassword) headers["x-custom-auth"] = secret.sitePassword;
  const result = await providerJson(config.baseUrl, `/api/mail/${encodeURIComponent(id)}`, headers, signal,
    undefined, { expectedStatus: 200, maxBytes: 8 * 1024 * 1024 });
  if (result === null) throw new HttpError(404, "attachment_source_missing");
  const row = object(result);
  if (remoteId(row.id) !== id || string(row.address, 320).toLowerCase() !== address) throw new HttpError(502, "provider_recipient_mismatch");
  let parsed;
  try {
    parsed = await PostalMime.parse(string(row.raw, 8 * 1024 * 1024), { maxNestingDepth: 32,
      maxHeadersSize: 256 * 1024, maxPartCount: 200, maxRfc822NestingDepth: 5, maxForwardedAddresses: 100 });
  } catch { throw new HttpError(502, "attachment_parse_failed"); }
  const part = parsed.attachments[expected.index!];
  if (!part || typeof part.content === "string") throw new HttpError(409, "attachment_source_changed");
  const bytes = new Uint8Array(part.content);
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES || bytes.byteLength !== expected.size) throw new HttpError(409, "attachment_source_changed");
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer)))
    .map((value) => value.toString(16).padStart(2, "0")).join("");
  if (hash !== expected.sha256) throw new HttpError(409, "attachment_source_changed");
  return bytes;
}
