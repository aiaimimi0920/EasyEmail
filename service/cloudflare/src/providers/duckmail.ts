import { HttpError } from "../http";
import { validDomain } from "../mail-address";
import { randomToken } from "../security";
import type { Provider, ProviderConfig, ProviderSecret } from "./contracts";
import { object, providerJson, string } from "./http";
import { duckmailAccount, duckmailContent, duckmailId, duckmailRecipient } from "./duckmail-content";
import { duckmailPage } from "./duckmail-page";

export function duckmailProvider(config: ProviderConfig, secret: ProviderSecret | null, signal: AbortSignal): Provider {
  const platformHeaders: Record<string, string> = secret ? { authorization: `Bearer ${secret.apiKey}` } : {};
  const request = (path: string, headers: Record<string, string>, body?: unknown, expectedStatus = 200) =>
    providerJson(config.baseUrl, path, headers, signal, body, { expectedStatus });
  return {
    mailboxLifetimeSeconds: 86400,
    async domains() {
      const domains = new Set<string>(); let page = 1, total: number | undefined;
      while (true) {
        const data = duckmailPage(await request(`/domains?page=${page}`, platformHeaders), config.baseUrl, "/domains", page, 1000);
        if (total !== undefined && total !== data.total) throw new HttpError(502, "provider_invalid_response");
        total = data.total;
        for (const row of data.rows) {
          const domain = string(row.domain, 253).toLowerCase();
          if (!validDomain(domain) || row.isVerified !== true || domains.has(domain)) throw new HttpError(502, "provider_invalid_response");
          domains.add(domain);
        }
        if (data.nextPage === null) return [...domains];
        page = data.nextPage;
      }
    },
    async create(address) {
      const password = randomToken("");
      const account = object(await request("/accounts", platformHeaders, { address, password, expiresIn: 86400 }, 201)), id = duckmailId(account.id);
      duckmailAccount(account, id, address);
      // A platform API Key must never be substituted for a mailbox's password or read token.
      const login = object(await request("/token", {}, { address, password })), token = string(login.token, 4096);
      if (duckmailId(login.id) !== id || !/^[\x21-\x7e]+$/.test(token) || token === secret?.apiKey) throw new HttpError(502, "provider_invalid_response");
      await request("/me", { authorization: `Bearer ${token}` }).then(value => duckmailAccount(value, id, address));
      return { remoteId: id, credential: { token, duckmailId: id } };
    },
    async read(address, credential, page) {
      if (typeof credential.token !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(credential.token) || typeof credential.duckmailId !== "string"
        || !/^[a-zA-Z0-9_-]{1,128}$/.test(credential.duckmailId) || credential.token === secret?.apiKey) throw new HttpError(503, "mailbox_credential_unavailable");
      const id = credential.duckmailId, headers = { authorization: `Bearer ${credential.token}` };
      duckmailAccount(await request("/me", headers), id, address);
      const data = duckmailPage(await request(`/messages?page=${page}`, headers), config.baseUrl, "/messages", page, 30000);
      const items = [], seen = new Set<string>(); let missing = 0;
      for (const summary of data.rows) {
        const messageId = duckmailId(summary.id); duckmailRecipient(summary, id, address);
        if (seen.has(messageId)) throw new HttpError(502, "provider_invalid_response");
        seen.add(messageId); let detail;
        try { detail = await providerJson(config.baseUrl, `/messages/${encodeURIComponent(messageId)}`, headers, signal, undefined,
          { expectedStatus: 200, notFoundCode: "duckmail_message_missing" }); }
        catch (error) { if (error instanceof HttpError && error.code === "duckmail_message_missing") { missing++; continue; } throw error; }
        items.push(duckmailContent(detail, messageId, id, address));
      }
      return { items, nextPage: data.nextPage, missing };
    },
  };
}
