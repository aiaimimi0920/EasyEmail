import { HttpError } from "../http";
import type { MailCredential, ProviderConfig, ProviderSecret, RemoteDeleteState, RemoteMailboxDeleteInput, RemoteMailboxIdentity } from "./contracts";
import { object, providerJson } from "./http";

function headers(secret: ProviderSecret, credential: MailCredential) {
  if (!credential.token) throw new HttpError(503, "mailbox_credential_unavailable");
  return { ...(secret.sitePassword ? { "x-custom-auth": secret.sitePassword } : {}), authorization: `Bearer ${credential.token}` };
}
function cleanup(value: Record<string, unknown>) {
  if (value.cleanup !== "d1-mailbox-data-v1" || value.externalResourcesDeleted !== false) throw new HttpError(502, "provider_invalid_response");
}
export async function cloudflareMailboxDeleteCapability(config: ProviderConfig, secret: ProviderSecret, signal: AbortSignal,
  credential: MailCredential, account: RemoteMailboxIdentity): Promise<boolean> {
  const value = object(await providerJson(config.baseUrl, "/api/address_deletion_capability", headers(secret, credential), signal,
    undefined, { expectedStatus: 200, maxBytes: 4096 }));
  const capability = object(value.capability); cleanup(capability);
  if (capability.address !== account.address || capability.addressId !== account.addressId || capability.conditionalDelete !== true
    || typeof capability.enabled !== "boolean") throw new HttpError(502, "provider_invalid_response");
  return capability.enabled;
}
export async function cloudflareMailboxDelete(config: ProviderConfig, secret: ProviderSecret, signal: AbortSignal,
  credential: MailCredential, input: RemoteMailboxDeleteInput, check: boolean): Promise<RemoteDeleteState> {
  const value = object(await providerJson(config.baseUrl, `/api/address_deletions${check ? `/${input.requestId}` : ""}`,
    headers(secret, credential), signal, check ? undefined : input, { expectedStatus: 200, maxBytes: 4096 }));
  cleanup(value); const operation = object(value.operation);
  if (operation.requestId !== input.requestId || operation.addressId !== input.addressId || operation.address !== input.address
    || !["deleted", "absent", "changed"].includes(String(operation.state))) throw new HttpError(502, "provider_invalid_response");
  return operation.state as RemoteDeleteState;
}
