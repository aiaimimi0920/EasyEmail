import type { RetentionPolicy } from "./retention-policy";

export interface RetentionTarget { table: string; countColumn: string; view: string; where: string; values: number[]; assignments: string; order: string }

export function retentionTargets(policy: RetentionPolicy, now: number, contentReset: string): RetentionTarget[] {
  const age = (days: number) => now - days * 86400;
  const active = (days: number) => policy.enabled && days > 0;
  const messages: string[] = [], messageValues: number[] = [];
  if (active(policy.cacheDays)) { messages.push("observed_at <= ?"); messageValues.push(age(policy.cacheDays)); }
  if (active(policy.trashDays)) { messages.push("trashed_at IS NOT NULL AND trashed_at <= ?"); messageValues.push(age(policy.trashDays)); }
  return [
    { table: "mailboxes", countColumn: "expired_mailboxes", view: "expiredMailboxes",
      where: "expired_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?", values: [now], order: "expires_at,id",
      assignments: `expired_at = ?, credential_cipher = NULL, sync_token = NULL, sync_lease_until = NULL, sync_revision = sync_revision + 1` },
    { table: "messages", countColumn: "purged_messages", view: "purgedMessages",
      where: messages.length ? `purged_at IS NULL AND (${messages.join(" OR ")})` : "0", values: messageValues,
      order: active(policy.cacheDays) ? "observed_at,id" : "trashed_at,id",
      assignments: `purged_at = ?, ${contentReset}` },
    { table: "outgoing_messages", countColumn: "redacted_outgoing", view: "redactedOutgoing",
      where: active(policy.outgoingDays) ? "content_purged_at IS NULL AND state <> 'pending' AND updated_at <= ?" : "0",
      values: active(policy.outgoingDays) ? [age(policy.outgoingDays)] : [], order: "updated_at,id",
      assignments: "content_purged_at = ?, from_address = '', to_address = '', recipients_json = NULL, attachments_json = NULL, subject = '', text_body = ''" },
    { table: "admin_audit", countColumn: "pruned_audit", view: "prunedAudit",
      where: active(policy.auditDays) ? "created_at <= ?" : "0", values: active(policy.auditDays) ? [age(policy.auditDays)] : [],
      order: "created_at,id", assignments: "" },
  ];
}
