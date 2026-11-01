import { HttpError } from "../http";
import { MAIL_PAGE_SIZE, type MailContent, type Provider, type ProviderConfig, type ProviderSecret } from "./contracts";
import { object, optionalString, providerJson, receivedTime, remoteId, string } from "./http";

function unwrap(value: unknown): unknown {
  const row = object(value);
  if (row.error === true || (row.code !== undefined && row.code !== 200)) throw new HttpError(502, "provider_invalid_response");
  return row.data;
}

export function temporamProvider(config: ProviderConfig, secret: ProviderSecret, signal: AbortSignal): Provider {
  const headers = { authorization: `Bearer ${secret.apiKey}` };
  return {
    async domains() {
      const data = unwrap(await providerJson(config.baseUrl, "/domains", headers, signal));
      if (!Array.isArray(data) || data.length > 1000) throw new HttpError(502, "provider_invalid_response");
      return data.map((value) => string(typeof value === "string" ? value : object(value).domain, 253).toLowerCase());
    },
    async create(address) {
      // Temporam v3 has no mailbox creation or lease API. Ownership lives in our D1 allocation.
      return { remoteId: address, credential: {} };
    },
    async read(address, _credential, page) {
      const data = unwrap(await providerJson(config.baseUrl,
        `/emails?email=${encodeURIComponent(address)}&page=${page}&limit=${MAIL_PAGE_SIZE}`, headers, signal));
      if (!Array.isArray(data) || data.length > MAIL_PAGE_SIZE) throw new HttpError(502, "provider_invalid_response");
      const items: MailContent[] = [];
      let missing = 0;
      for (const value of data) {
        const id = remoteId(object(value).id);
        const detail = unwrap(await providerJson(config.baseUrl, `/emails/${encodeURIComponent(id)}`, headers, signal));
        if (detail === null) { missing++; continue; }
        const row = object(detail);
        if (remoteId(row.id) !== id) throw new HttpError(502, "provider_invalid_response");
        const recipient = optionalString(row, ["toEmail", "email", "to"], 320).toLowerCase();
        if (recipient && recipient !== address) throw new HttpError(502, "provider_recipient_mismatch");
        items.push({ remoteId: id, recipient: address, sender: optionalString(row, ["fromEmail", "from", "sender"], 2048),
          subject: optionalString(row, ["subject"], 4096),
          textBody: optionalString(row, ["textBody", "text_body", "text", "plainText", "plain", "content", "body", "message"]),
          htmlBody: optionalString(row, ["htmlBody", "html_body", "html"]), attachments: [],
          receivedAt: receivedTime(row.createdAt ?? row.created_at) });
      }
      return { items, nextPage: data.length === MAIL_PAGE_SIZE ? page + 1 : null, missing };
    },
  };
}
