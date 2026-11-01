import { HttpError } from '../http';
import type { ProviderConfig, ProviderSecret, ProviderMailbox } from './contracts';
import { object, providerJson } from './http';

export async function cloudflareRecovery(config: ProviderConfig, secret: ProviderSecret, signal: AbortSignal,
  address: string, token: string): Promise<ProviderMailbox> {
  const row = object(await providerJson(config.baseUrl, '/api/mailbox_identity', {
    ...(secret.sitePassword ? { 'x-custom-auth': secret.sitePassword } : {}), authorization: `Bearer ${token}`,
  }, signal, undefined, { expectedStatus: 200, maxBytes: 4096, notFoundCode: 'mailbox_recovery_unavailable' }));
  if (row.contract !== 'easyemail-mailbox-identity-v1' || row.address !== address || typeof row.addressId !== 'string'
    || !/^[1-9]\d{0,15}$/.test(row.addressId) || !Number.isSafeInteger(Number(row.addressId))
    || (row.expiresAt !== null && (!Number.isSafeInteger(row.expiresAt) || (row.expiresAt as number) <= Math.floor(Date.now() / 1000)))) {
    throw new HttpError(502, 'mailbox_proof_invalid');
  }
  return { remoteId: row.addressId, credential: { token }, expiresAt: row.expiresAt as number | null };
}
