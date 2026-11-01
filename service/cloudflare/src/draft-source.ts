import type { Env, Identity } from "./contracts";
import type { DraftContent } from "./draft-input";
import type { DraftRow } from "./draft-store";
import { HttpError } from "./http";

export function draftSourceScope(accountId?: string) {
  return accountId ? { sql: "normal_account_id=?", values: [accountId] }
    : { sql: "normal_account_id IS NULL", values: [] };
}
export const draftSourceMatches = (row: DraftRow, accountId?: string) => (row.normal_account_id ?? null) === (accountId ?? null);

export function draftSourceFence(identity: Identity, input: DraftContent) {
  return input.normalAccountId ? {
    sql: "EXISTS (SELECT 1 FROM normal_accounts a JOIN users u ON u.id=a.user_id WHERE a.id=? AND a.user_id=? AND a.revision=? AND a.deleted_at IS NULL AND u.status='active')",
    values: [input.normalAccountId, identity.userId, input.accountRevision!],
  } : { sql: "1", values: [] };
}
export async function assertNormalDraftSource(env: Env, identity: Identity, input: DraftContent) {
  if (!input.normalAccountId) return;
  const row = await env.DB.prepare("SELECT revision,deleted_at FROM normal_accounts WHERE id=? AND user_id=?")
    .bind(input.normalAccountId, identity.userId).first<{ revision: number; deleted_at: number | null }>();
  if (!row || row.deleted_at !== null) throw new HttpError(404, "not_found");
  if (row.revision !== input.accountRevision) throw new HttpError(409, "normal_account_changed");
}
