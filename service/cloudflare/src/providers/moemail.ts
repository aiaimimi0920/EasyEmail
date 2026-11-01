import { HttpError } from "../http";
import { validDomain } from "../mail-address";
import type { Provider, ProviderConfig, ProviderSecret } from "./contracts";
import { object, providerJson, string } from "./http";
import { moemailContent, moemailId, moemailRecipient } from "./moemail-content";

export function moemailProvider(config: ProviderConfig, secret: ProviderSecret, signal: AbortSignal): Provider {
  const headers = { "x-api-key": secret.apiKey };
  const request = (path: string, body?: unknown) => providerJson(config.baseUrl, path, headers, signal, body, { expectedStatus: 200 });
  return {
    cursorPaging: true,
    mailboxLifetimeSeconds: 3600,
    async domains() {
      const row = object(await request("/api/config")), raw = string(row.emailDomains, 65536);
      const domains = raw.split(",").map(value => value.trim().toLowerCase());
      if (!domains.length || domains.length > 1000 || !domains.every(validDomain)) throw new HttpError(502, "provider_invalid_response");
      return [...new Set(domains)];
    },
    async create(address) {
      const [name, domain] = address.split("@");
      const row = object(await request("/api/emails/generate", { name, domain, expiryTime: 3600000 }));
      if (string(row.email, 254).toLowerCase() !== address) throw new HttpError(502, "provider_recipient_mismatch");
      const id = moemailId(row.id);
      return { remoteId: id, credential: { moemailId: id } };
    },
    async read(address, credential, page, cursor) {
      if (typeof credential?.moemailId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(credential.moemailId)) throw new HttpError(503, "mailbox_credential_unavailable");
      const path = `/api/emails/${encodeURIComponent(credential.moemailId)}`;
      const row = object(await request(path + (cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`)));
      if (!Array.isArray(row.messages) || row.messages.length > 20
        || !(row.nextCursor === null || typeof row.nextCursor === "string" && row.nextCursor.length > 0 && row.nextCursor.length <= 2048 && !/[\x00-\x1f\x7f]/.test(row.nextCursor))
        || row.nextCursor !== null && (!row.messages.length || row.nextCursor === cursor || page >= 1000)) throw new HttpError(502, "provider_invalid_response");
      const items = [], seen = new Set<string>();
      let missing = 0;
      for (const value of row.messages) {
        const summary = object(value), id = moemailId(summary.id);
        if (seen.has(id)) throw new HttpError(502, "provider_invalid_response");
        seen.add(id); moemailRecipient(summary, address);
        let detail;
        try { detail = object(await providerJson(config.baseUrl, `${path}/${encodeURIComponent(id)}`, headers, signal, undefined,
          { expectedStatus: 200, notFoundCode: "moemail_message_missing" })); }
        catch (error) { if (error instanceof HttpError && error.code === "moemail_message_missing") { missing++; continue; } throw error; }
        items.push(moemailContent(detail.message, id, address));
      }
      return { items, nextPage: row.nextCursor === null ? null : page + 1, nextCursor: row.nextCursor as string | null, missing };
    },
  };
}
