import type { RetentionPolicy } from "./retention-policy";
import type { Env } from "./contracts";

export const NORMAL_STAGING_GRACE = 86400;
// Upgrade tests and overlapping old schemas still use the original table until migration 0055 is applied.
export async function normalReceiveLeaseTable(env: Env) {
  return await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='view' AND name='normal_receive_leases'").first()
    ? "normal_receive_leases" : "normal_inbox_state";
}
export const normalNoLiveSync = (leaseTable: string) => `NOT EXISTS (SELECT 1 FROM ${leaseTable} s
  WHERE s.account_id=m.account_id AND s.claim_token IS NOT NULL AND s.claim_lease_until>unixepoch())`;
export function normalRetentionSelection(policy: RetentionPolicy, now: number, leaseTable = "normal_inbox_state") {
  const ages: string[] = [], values: number[] = [];
  if (policy.enabled && policy.cacheDays) { ages.push("m.observed_at<=?"); values.push(now - policy.cacheDays * 86400); }
  if (policy.enabled && policy.trashDays) {
    ages.push("EXISTS (SELECT 1 FROM normal_message_state ns WHERE ns.message_id=m.id AND ns.trashed_at<=?)");
    values.push(now - policy.trashDays * 86400);
  }
  return { where: `m.purged_at IS NULL AND (${ages.join(" OR ") || "0"}) AND ${normalNoLiveSync(leaseTable)}
    AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.normal_account_id=m.account_id AND d.normal_reply_message_id=m.id AND d.state='editing')
    AND NOT EXISTS (SELECT 1 FROM normal_send_jobs j WHERE j.account_id=m.account_id AND j.deadline_at>unixepoch()
      AND j.state IN ('queued','preparing','failed') AND json_extract(j.payload_json,'$.reply')=m.id)
    AND NOT EXISTS (SELECT 1 FROM normal_outgoing_messages o WHERE o.account_id=m.account_id AND o.reply_message_id=m.id AND o.state='pending')`, values };
}
export const normalStagingSelection = (leaseTable = "normal_inbox_state") => `m.status='staged' AND m.retired_at IS NULL AND m.created_at<=? AND ${normalNoLiveSync(leaseTable)}`;
