import { HttpError } from "../http";
import type { MailCredential, ProviderConfig, ProviderSecret, RemoteDeleteInput, RemoteDeleteState } from "./contracts";
import { object, providerJson } from "./http";

export async function cloudflareDelete(config: ProviderConfig, secret: ProviderSecret, signal: AbortSignal,
  credential: MailCredential, input: RemoteDeleteInput, check: boolean): Promise<RemoteDeleteState> {
  if (!credential.token) throw new HttpError(503, "mailbox_credential_unavailable");
  const headers = { ...(secret.sitePassword ? { "x-custom-auth": secret.sitePassword } : {}), authorization: `Bearer ${credential.token}` };
  const value = object(await providerJson(config.baseUrl, `/api/mail_deletions${check ? `/${input.requestId}` : ""}`,
    headers, signal, check ? undefined : input, { expectedStatus: 200, maxBytes: 4096 }));
  const operation = object(value.operation);
  if (operation.requestId !== input.requestId || operation.mailId !== input.mailId || operation.expectedVersion !== input.expectedVersion
    || !["deleted", "absent", "changed"].includes(String(operation.state))) throw new HttpError(502, "provider_invalid_response");
  return operation.state as RemoteDeleteState;
}
