import { HttpError } from "../http";
import { MAIL_PAGE_SIZE, type MailContent, type Provider, type ProviderConfig, type ProviderSecret } from "./contracts";
import { object, optionalString, providerJson, receivedTime, remoteId, string } from "./http";
import { rfcMessageId } from "../mail-address";
import { cloudflareSend } from "./cloudflare-send";
import { cloudflareAttachment } from "./cloudflare-attachment";
import { cloudflareDelete } from "./cloudflare-delete";
import { cloudflareMailboxDelete, cloudflareMailboxDeleteCapability } from "./cloudflare-mailbox-delete";
import { cloudflareCustomCapability, cloudflareCustomCreate } from "./cloudflare-create";
import { parseThreadHeaders } from "../message-thread-input";
import { parseSubscriptionHeaders } from "../subscription-input";
import { cloudflareRecovery } from './cloudflare-recovery';

function parseMail(value: unknown, address: string): MailContent {
  const row = object(value);
  if (string(row.address, 320).toLowerCase() !== address) throw new HttpError(502, "provider_recipient_mismatch");
  if (row.attachments !== undefined && !Array.isArray(row.attachments)) throw new HttpError(502, "provider_invalid_response");
  if ((row.resource_version != null && (typeof row.resource_version !== "string" || !/^[0-9a-f]{32}$/.test(row.resource_version)))
    || (row.remote_delete_enabled !== undefined && typeof row.remote_delete_enabled !== "boolean")) throw new HttpError(502, "provider_invalid_response");
  const attachments = (row.attachments as unknown[] ?? []).slice(0, 100).map((value, index) => {
    const item = object(value);
    if (item.sha256 !== undefined && (typeof item.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(item.sha256)
      || item.index !== index || !Number.isSafeInteger(item.size) || (item.size as number) < 0)) throw new HttpError(502, "provider_invalid_response");
    return { filename: optionalString(item, ["filename"], 512), mimeType: optionalString(item, ["mimeType"], 256),
      size: typeof item.size === "number" && item.size >= 0 ? item.size : 0,
      ...(item.sha256 ? { index, sha256: item.sha256 as string } : {}) };
  });
  return { remoteId: remoteId(row.id), recipient: address, sender: optionalString(row, ["sender", "source"], 2048),
    subject: optionalString(row, ["subject"], 4096), textBody: optionalString(row, ["text"]),
    htmlBody: optionalString(row, ["html"]), attachments, receivedAt: receivedTime(row.created_at, true),
    rfcMessageId: rfcMessageId(row.message_id), attachmentsTruncated: (row.attachments as unknown[] ?? []).length > 100,
    ...(row.thread_headers === undefined ? {} : { threadHeaders: parseThreadHeaders(row.thread_headers) }),
    ...(row.subscription_headers === undefined ? {} : { subscriptionHeaders: parseSubscriptionHeaders(row.subscription_headers) }),
    ...(typeof row.resource_version === "string" ? { resourceVersion: row.resource_version, remoteDeleteEnabled: row.remote_delete_enabled === true } : {}) };
}

export function cloudflareProvider(config: ProviderConfig, secret: ProviderSecret, signal: AbortSignal): Provider {
  const site: Record<string, string> = secret.sitePassword ? { "x-custom-auth": secret.sitePassword } : {};
  return {
    recoverAccess: (address, token) => cloudflareRecovery(config, secret, signal, address, token),
    customAddressCapability: () => cloudflareCustomCapability(config, secret, signal),
    createCustom: (address) => cloudflareCustomCreate(config, secret, signal, address),
    send: config.sendTransport ? (mail, credential) => cloudflareSend(config, secret, signal, mail, credential) : undefined,
    attachment: (address, credential, id, expected) => cloudflareAttachment(config, secret, signal, address, credential, id, expected),
    remoteDelete: (credential, input, check) => cloudflareDelete(config, secret, signal, credential, input, check),
    mailboxDeleteCapability: (credential, account) => cloudflareMailboxDeleteCapability(config, secret, signal, credential, account),
    remoteMailboxDelete: (credential, input, check) => cloudflareMailboxDelete(config, secret, signal, credential, input, check),
    async domains() { return config.domains; },
    async create(address) {
      const [name, domain] = address.split("@");
      const row = object(await providerJson(config.baseUrl, "/admin/new_address",
        { ...site, "x-admin-auth": secret.apiKey }, signal, { name, domain, enablePrefix: false, enableRandomSubdomain: false }));
      if (string(row.address, 320).toLowerCase() !== address) throw new HttpError(502, "provider_recipient_mismatch");
      const token = string(row.jwt, 16384);
      if (!token) throw new HttpError(502, "provider_invalid_response");
      return { remoteId: remoteId(row.address_id), credential: { token } };
    },
    async read(address, credential, page) {
      if (!credential.token) throw new HttpError(503, "mailbox_credential_unavailable");
      const row = object(await providerJson(config.baseUrl,
        `/api/parsed_mails?limit=${MAIL_PAGE_SIZE}&offset=${(page - 1) * MAIL_PAGE_SIZE}`,
        { ...site, authorization: `Bearer ${credential.token}` }, signal));
      if (!Array.isArray(row.results) || row.results.length > MAIL_PAGE_SIZE) throw new HttpError(502, "provider_invalid_response");
      return { items: row.results.map((value) => parseMail(value, address)),
        nextPage: row.results.length === MAIL_PAGE_SIZE ? page + 1 : null, missing: 0 };
    },
  };
}
