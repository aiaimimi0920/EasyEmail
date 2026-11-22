// Closed server-owned descriptors. Request bodies and persisted payloads never choose SQL identifiers or scopes.
export const TEMPORARY_JOBS = {
  kind: "temporary", table: "send_jobs", operations: "send_job_operations", outgoing: "outgoing_messages",
  scheduleScope: "messages:schedule", sendScope: "messages:send", unavailable: "mailbox_unavailable",
  usable: `EXISTS (SELECT 1 FROM mailboxes b WHERE b.id=send_jobs.mailbox_id AND b.user_id=send_jobs.user_id
    AND b.status='active' AND b.disabled_at IS NULL AND b.released_at IS NULL AND b.expired_at IS NULL AND (b.expires_at IS NULL OR b.expires_at>unixepoch()))`,
} as const;
export const NORMAL_JOBS = {
  kind: "normal", table: "normal_send_jobs", operations: "normal_send_job_operations", outgoing: "normal_outgoing_messages",
  scheduleScope: "mail-accounts:schedule", sendScope: "mail-accounts:send", unavailable: "normal_account_unavailable",
  usable: `EXISTS (SELECT 1 FROM normal_accounts a WHERE a.id=normal_send_jobs.account_id AND a.user_id=normal_send_jobs.user_id
    AND a.enabled=1 AND a.deleted_at IS NULL)`,
} as const;
export type JobSource = typeof TEMPORARY_JOBS | typeof NORMAL_JOBS;
export const JOB_SOURCES: readonly JobSource[] = [TEMPORARY_JOBS, NORMAL_JOBS];
export const noJobOutgoing = (source: JobSource) => `NOT EXISTS (SELECT 1 FROM ${source.outgoing} o WHERE o.user_id=${source.table}.user_id AND o.request_key=${source.table}.outgoing_key)`;
export const activeJobUser = (source: JobSource) => `EXISTS (SELECT 1 FROM users u WHERE u.id=${source.table}.user_id AND u.status='active')`;
