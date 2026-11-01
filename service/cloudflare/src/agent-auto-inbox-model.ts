import { HttpError } from "./http";
export interface AutoInboxCommand {
  expectedAccountRevision: number; expectedRevision: number; enabled: boolean; intervalMinutes: number; persistentAuthorization: boolean;
}
export interface AutoInboxRow {
  account_id: string; user_id: string; revision: number; account_revision: number; source_hash: string; enabled: number; interval_minutes: number;
  next_due_at: number | null; run_token: string | null; run_request_id: string | null; lease_until: number | null; failures: number;
  last_state: string; last_error_code: string | null; last_request_key: string | null; last_started_at: number | null; last_finished_at: number | null;
}
export interface AutoInboxOperation {
  id: string; user_id: string; account_id: string; request_key: string; request_hash: string; account_revision: number;
  expected_revision: number; revision: number; enabled: number; interval_minutes: number; completed_at: number | null;
}
export function autoInboxCommand(value: unknown): AutoInboxCommand {
  const row = value as AutoInboxCommand;
  if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).length !== 5
    || !["expectedAccountRevision", "expectedRevision", "enabled", "intervalMinutes", "persistentAuthorization"].every(key => Object.hasOwn(row, key))
    || !Number.isSafeInteger(row.expectedAccountRevision) || row.expectedAccountRevision < 1
    || !Number.isSafeInteger(row.expectedRevision) || row.expectedRevision < 0 || row.expectedRevision >= Number.MAX_SAFE_INTEGER
    || typeof row.enabled !== "boolean" || ![5, 15, 60].includes(row.intervalMinutes)
    || row.persistentAuthorization !== row.enabled) throw new HttpError(400, "invalid_agent_auto_inbox_request");
  return row;
}
export function autoInboxOperationView(row: AutoInboxOperation) {
  if (row.completed_at === null) throw new HttpError(503, "agent_auto_inbox_unconfirmed");
  return { id: row.id, accountId: row.account_id, requestKey: row.request_key, accountRevision: row.account_revision,
    expectedRevision: row.expected_revision, revision: row.revision, enabled: !!row.enabled, intervalMinutes: row.interval_minutes,
    persistentAuthorization: !!row.enabled, completedAt: row.completed_at };
}
