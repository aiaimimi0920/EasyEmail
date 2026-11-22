import { HttpError } from '../http';
import { validDomain } from '../mail-address';
import type { CustomAddressCapability, ProviderConfig, ProviderMailbox, ProviderSecret } from './contracts';
import { object, providerJson, remoteId, string } from './http';

const headers = (secret: ProviderSecret) => ({ 'x-admin-auth': secret.apiKey,
  ...(secret.sitePassword ? { 'x-custom-auth': secret.sitePassword } : {}) });

export async function cloudflareCustomCapability(config: ProviderConfig, secret: ProviderSecret, signal: AbortSignal): Promise<CustomAddressCapability> {
  const row = object(await providerJson(config.baseUrl, '/admin/custom_address_capability', headers(secret), signal, undefined,
    { expectedStatus: 200, maxBytes: 65536, notFoundCode: 'custom_prefix_unavailable' }));
  if (row.contract !== 'easyemail-custom-address-v1' || typeof row.enabled !== 'boolean'
    || !Number.isInteger(row.minLength) || !Number.isInteger(row.maxLength) || (row.minLength as number) < 1
    || (row.maxLength as number) > 30 || (row.minLength as number) > (row.maxLength as number)
    || !Array.isArray(row.domains) || row.domains.length > 256 || !row.domains.every((domain) => typeof domain === 'string' && validDomain(domain))) {
    throw new HttpError(502, 'provider_invalid_response');
  }
  return { enabled: row.enabled, minLength: row.minLength as number, maxLength: row.maxLength as number,
    domains: [...new Set(row.domains as string[])].filter((domain) => !config.domains.length || config.domains.includes(domain)) };
}

export async function cloudflareCustomCreate(config: ProviderConfig, secret: ProviderSecret, signal: AbortSignal, address: string): Promise<ProviderMailbox> {
  const [name, domain] = address.split('@');
  const row = object(await providerJson(config.baseUrl, '/admin/custom_address', headers(secret), signal, { name, domain },
    { expectedStatus: 201, maxBytes: 65536 }));
  if (string(row.address, 320) !== address) throw new HttpError(502, 'provider_recipient_mismatch');
  const token = string(row.jwt, 16384), id = remoteId(row.address_id);
  if (!token || !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new HttpError(502, 'provider_invalid_response');
  return { remoteId: id, credential: { token } };
}
