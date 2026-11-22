import { HttpError } from "../http";
import { validDomain } from "../mail-address";
import { tokenHash } from "../security";
import type { Provider, ProviderConfig, ProviderSecret } from "./contracts";
import { object, providerJson, string } from "./http";
import { im215Account, im215Content, im215Data, im215Id, im215Token } from "./im215-content";
import { im215Cursor, im215Page } from "./im215-page";

export function im215Provider(config: ProviderConfig, secret: ProviderSecret, signal: AbortSignal): Provider {
  if (!/^AC-[\x21-\x7e]{1,4093}$/.test(secret.apiKey)) throw new HttpError(503, "provider_secret_unavailable");
  const platform = { "x-api-key": secret.apiKey };
  const request = async (path: string, headers: Record<string, string>, body?: unknown, expectedStatus = 200) =>
    im215Data(await providerJson(config.baseUrl, path, headers, signal, body, { expectedStatus }));
  return {
    cursorPaging: true,
    async domains() {
      const values = await request("/domains", platform);
      if (!Array.isArray(values) || values.length > 1000) throw new HttpError(502, "provider_invalid_response");
      const seen = new Set<string>(), ready: string[] = [];
      for (const value of values) {
        const row = object(value), domain = string(row.domain, 253).toLowerCase();
        if (!validDomain(domain) || seen.has(domain) || typeof row.isVerified !== "boolean" || typeof row.isMxValid !== "boolean") throw new HttpError(502, "provider_invalid_response");
        seen.add(domain); if (row.isVerified && row.isMxValid) ready.push(domain);
      }
      return ready;
    },
    async create(address) {
      const [localPart, domain] = address.split("@"), key = `ee-${await tokenHash(`im215:${config.id}:${address}`)}`;
      const row = object(await request("/accounts", { ...platform, "idempotency-key": key }, { localPart, domain }, 201)), id = im215Id(row.id);
      const deadline = im215Account(row, id, address), token = im215Token(row.token);
      if (row.mode !== "fixed" || token === secret.apiKey || token.startsWith("AC-")) throw new HttpError(502, "provider_invalid_response");
      const checked = im215Account(await request("/accounts/me", { authorization: `Bearer ${token}` }), id, address);
      const expiresAt = deadline === null ? checked : checked === null ? deadline : Math.min(deadline, checked);
      return { remoteId: id, credential: { token, im215Id: id }, expiresAt };
    },
    async read(address, credential, page, cursor) {
      let token: string, id: string;
      try { token = im215Token(credential.token); id = im215Id(credential.im215Id); }
      catch { throw new HttpError(503, "mailbox_credential_unavailable"); }
      if (token === secret.apiKey || token.startsWith("AC-")) throw new HttpError(503, "mailbox_credential_unavailable");
      const after = im215Cursor(page, cursor), headers = { authorization: `Bearer ${token}` };
      im215Account(await request("/accounts/me", headers), id, address);
      const query = new URLSearchParams({ limit: "10", since: "1970-01-01T00:00:00Z", ...(after ? { after_id: after } : {}) });
      const data = im215Page(await request(`/inboxes/${encodeURIComponent(id)}/messages?${query}`, headers), id, after);
      if (data.nextCursor !== null && page >= 1000) throw new HttpError(502, "provider_response_too_large");
      const items = []; let missing = 0;
      for (const row of data.rows) {
        let detail;
        try { detail = im215Data(await providerJson(config.baseUrl, `/messages/${encodeURIComponent(row.id)}?${new URLSearchParams({ address })}`, headers,
          signal, undefined, { expectedStatus: 200, notFoundCode: "im215_message_missing" })); }
        catch (error) { if (error instanceof HttpError && error.code === "im215_message_missing") { missing++; continue; } throw error; }
        items.push(im215Content(detail, row.id, id, address));
      }
      return { items, nextPage: data.nextCursor === null ? null : page + 1, nextCursor: data.nextCursor, missing };
    },
  };
}
