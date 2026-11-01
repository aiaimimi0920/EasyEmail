import { HttpError } from "../http";
import { mailAddress } from "../mail-address";
import type { Provider, ProviderConfig } from "./contracts";
import { object, providerJson } from "./http";
import { guerrillaAuth, guerrillaContent, guerrillaToken } from "./guerrillamail-content";
import { guerrillaCursor, guerrillaPage } from "./guerrillamail-page";

export function guerrillamailProvider(config: ProviderConfig, signal: AbortSignal): Provider {
  const call = (f: string, parameters: Record<string, string> = {}) => providerJson(config.baseUrl,
    `?${new URLSearchParams({ f, lang: "en", ...parameters })}`, {}, signal, undefined, { expectedStatus: 200 });
  return {
    cursorPaging: true,
    async domains() { return config.domains; },
    async create(address) {
      // Both actions can create upstream state; they run only after the platform's creation guard.
      const seed = object(await call("get_email_address")); guerrillaAuth(seed);
      if (!mailAddress(seed.email_addr)) throw new HttpError(502, "provider_invalid_response");
      const row = object(await call("set_email_user", { email_user: address.split("@")[0], sid_token: guerrillaToken(seed.sid_token) })); guerrillaAuth(row);
      if (mailAddress(row.email_addr) !== address) throw new HttpError(502, "provider_recipient_mismatch");
      return { remoteId: address, credential: { token: guerrillaToken(row.sid_token) } };
    },
    async read(address, credential, page, cursor, context) {
      let token: string;
      try { token = guerrillaToken(credential.token); } catch { throw new HttpError(503, "mailbox_credential_unavailable"); }
      const below = guerrillaCursor(page, cursor);
      const data = guerrillaPage(await call(below === undefined ? "check_email" : "get_older_list",
        { sid_token: token, seq: below ?? "0", ...(below === undefined ? {} : { limit: "20" }) }), address, below);
      const checkpoint = async (next: string) => {
        if (next === token) return;
        if (!context) throw new HttpError(409, "provider_session_changed");
        await context.checkpointCredential({ token: next }); token = next;
      };
      await checkpoint(data.token);
      if (data.nextCursor !== null && page >= 1000) throw new HttpError(502, "provider_response_too_large");
      const items = []; let missing = 0;
      for (const { id } of data.rows) {
        const detail = await call("fetch_email", { sid_token: token, email_id: id });
        if (detail === false) { missing++; continue; }
        const content = guerrillaContent(detail, id, address);
        await checkpoint(guerrillaToken(object(detail).sid_token)); items.push(content);
      }
      return { items, nextPage: data.nextCursor === null ? null : page + 1, nextCursor: data.nextCursor, missing };
    },
  };
}
