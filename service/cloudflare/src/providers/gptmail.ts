import { HttpError } from "../http";
import { tokenHash } from "../security";
import { MAIL_PAGE_SIZE, type Provider, type ProviderConfig, type ProviderSecret } from "./contracts";
import { object, providerJson } from "./http";
import { gptmailContent, gptmailData, gptmailId, gptmailRecipient } from "./gptmail-content";

const MAX_LIST_MESSAGES = 200;

export function gptmailProvider(config: ProviderConfig, secret: ProviderSecret, signal: AbortSignal): Provider {
  const headers = { "x-api-key": secret.apiKey };
  return {
    cursorPaging: true,
    async domains() { return [...config.domains]; },
    async create(address) {
      // Official API permits composing a supported address locally; this is not an upstream private mailbox lease.
      return { remoteId: address, credential: {} };
    },
    async read(address, _credential, page, cursor) {
      const query = `?email=${encodeURIComponent(address)}`;
      const data = gptmailData(await providerJson(config.baseUrl, `/api/emails${query}`, headers, signal, undefined, { expectedStatus: 200 }));
      if (Array.isArray(data.emails) && data.emails.length > MAX_LIST_MESSAGES) throw new HttpError(502, "provider_list_limit");
      if (!Array.isArray(data.emails) || data.count !== data.emails.length || data.has_more !== undefined && data.has_more !== false
        || data.next_cursor != null || data.nextCursor != null || data.next != null) throw new HttpError(502, "provider_invalid_response");
      const ids = data.emails.map(value => { const row = object(value); gptmailRecipient(row, address); return gptmailId(row.id); }).sort();
      if (new Set(ids).size !== ids.length) throw new HttpError(502, "provider_invalid_response");
      const snapshot = await tokenHash(JSON.stringify([address, ids])), offset = (page - 1) * MAIL_PAGE_SIZE;
      // A bounded complete ID list is re-read on each batch. Never continue an offset against a changed list.
      if (page !== 1 && (cursor !== `gpt1:${snapshot}:${offset}` || offset >= ids.length)) throw new HttpError(409, "provider_snapshot_changed");
      const items = [];
      let missing = 0;
      for (const id of ids.slice(offset, offset + MAIL_PAGE_SIZE)) {
        let detail;
        try { detail = await providerJson(config.baseUrl, `/api/email/${encodeURIComponent(id)}${query}`, headers, signal, undefined,
          { expectedStatus: 200, notFoundCode: "gptmail_message_missing" }); }
        catch (error) { if (error instanceof HttpError && error.code === "gptmail_message_missing") { missing++; continue; } throw error; }
        items.push(gptmailContent(detail, id, address));
      }
      const nextOffset = offset + MAIL_PAGE_SIZE, more = nextOffset < ids.length;
      return { items, nextPage: more ? page + 1 : null, nextCursor: more ? `gpt1:${snapshot}:${nextOffset}` : null, missing };
    },
  };
}
