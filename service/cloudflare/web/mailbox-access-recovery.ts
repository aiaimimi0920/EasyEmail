export interface RecoveryInput { providerId: string; address: string; token: string }
export interface RecoveryReceipt {
  requestKey: string; mailboxId: string; providerId: string; address: string;
  mode: 'imported' | 'restored' | 'refreshed'; createdAt: number;
}
export function readRecovery(value: unknown, key: string, input?: Pick<RecoveryInput, 'providerId' | 'address'>): RecoveryReceipt {
  const row = (value as { recovery?: RecoveryReceipt } | null)?.recovery;
  if (!row || row.requestKey !== key || input && (row.providerId !== input.providerId || row.address !== input.address)
    || typeof row.providerId !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(row.providerId)
    || typeof row.address !== 'string' || row.address.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.address)
    || typeof row.mailboxId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.mailboxId)
    || !['imported', 'restored', 'refreshed'].includes(row.mode) || !Number.isSafeInteger(row.createdAt) || row.createdAt <= 0) {
    throw new Error('mailbox_recovery_response_invalid');
  }
  return row;
}
