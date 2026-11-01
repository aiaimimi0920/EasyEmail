import { HttpError, textField } from "./http";
import { validDomain } from "./mail-address";
import { tokenHash } from "./security";

export interface AllocationInput { automatic: boolean; providerId?: string; domain?: string; prefix?: string; hash: string }

export async function allocationInput(body: Record<string, unknown>): Promise<AllocationInput> {
  const prefix = body.prefix;
  if (prefix !== undefined && (typeof prefix !== 'string' || !/^[a-z0-9]{1,30}$/.test(prefix))) throw new HttpError(400, 'invalid_mailbox_prefix');
  if (body.selection === "automatic") {
    if (Object.keys(body).some((key) => !["selection", "domain", "prefix"].includes(key))) throw new HttpError(400, "invalid_mailbox_request");
    const domain = body.domain === undefined ? undefined : textField(body, "domain", 1, 253).toLowerCase();
    if (domain && !validDomain(domain)) throw new HttpError(400, "invalid_mailbox_request");
    return { automatic: true, domain, prefix, hash: await tokenHash(JSON.stringify({ selection: "automatic", domain: domain ?? null, ...(prefix === undefined ? {} : { prefix }) })) };
  }
  if (Object.keys(body).some((key) => !["providerId", "domain", "prefix"].includes(key))) throw new HttpError(400, "invalid_mailbox_request");
  const providerId = textField(body, "providerId", 1, 48), domain = textField(body, "domain", 1, 253).toLowerCase();
  return { automatic: false, providerId, domain, prefix,
    hash: await tokenHash(JSON.stringify(prefix === undefined ? [providerId, domain] : [providerId, domain, { prefix }])) };
}
