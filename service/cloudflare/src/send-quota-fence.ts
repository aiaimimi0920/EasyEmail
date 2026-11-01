import { SEND_QUOTAS } from "./quota-policy";

// The view unions both owner models without changing either historical table.
export function sendQuotaFence(userId: string, now: number, count: number) {
  const day = Math.floor(now / 86400) * 86400;
  return { sql: `(SELECT COALESCE(SUM(recipient_count),0) FROM send_recipient_charges WHERE user_id=? AND created_at>=?)+?<=?
    AND (SELECT COALESCE(SUM(recipient_count),0) FROM send_recipient_charges WHERE user_id=? AND created_at>=?)+?<=?
    AND (SELECT COALESCE(SUM(recipient_count),0) FROM send_recipient_charges WHERE created_at>=?)+?<=?
    AND (SELECT COALESCE(SUM(recipient_count),0) FROM send_recipient_charges WHERE created_at>=?)+?<=?`,
    values: [userId, now - 60, count, SEND_QUOTAS.sendUserMinute, userId, day, count, SEND_QUOTAS.sendUserUtcDay,
      now - 60, count, SEND_QUOTAS.sendPlatformMinute, day, count, SEND_QUOTAS.sendPlatformUtcDay] };
}
