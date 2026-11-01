import type { Env } from "./contracts";
import { HttpError } from "./http";

export interface RetentionPolicy {
  enabled: boolean; mailboxDays: number; cacheDays: number; trashDays: number; outgoingDays: number; auditDays: number;
}
export interface RetentionState { policy: RetentionPolicy; revision: number; updatedAt: number | null; actorId: string | null }
export const RETENTION_DAYS = ["mailboxDays", "cacheDays", "trashDays", "outgoingDays", "auditDays"] as const;
export const RETENTION_BATCH_LIMIT = 100;
export const RETENTION_POLICY_FENCE = "EXISTS (SELECT 1 FROM retention_policy WHERE id = 1 AND revision = ?)";

export function parseRetentionPolicy(value: unknown): RetentionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_retention_policy");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 6 || Object.keys(row).some((key) => !["enabled", ...RETENTION_DAYS].includes(key))
    || typeof row.enabled !== "boolean" || RETENTION_DAYS.some((key) => !Number.isSafeInteger(row[key])
      || (row[key] as number) < 0 || (row[key] as number) > 3650)) throw new HttpError(400, "invalid_retention_policy");
  return { enabled: row.enabled, mailboxDays: row.mailboxDays as number, cacheDays: row.cacheDays as number,
    trashDays: row.trashDays as number, outgoingDays: row.outgoingDays as number, auditDays: row.auditDays as number };
}

export async function readRetention(env: Env): Promise<RetentionState> {
  const row = await env.DB.prepare(`SELECT enabled,mailbox_days,cache_days,trash_days,outgoing_days,audit_days,
    revision,updated_at,actor_id FROM retention_policy WHERE id = 1`).first<Record<string, unknown>>();
  try {
    if (!row || ![0, 1].includes(row.enabled as number) || !Number.isSafeInteger(row.revision) || (row.revision as number) < 0) throw new Error();
    const policy = parseRetentionPolicy({ enabled: row.enabled === 1, mailboxDays: row.mailbox_days, cacheDays: row.cache_days,
      trashDays: row.trash_days, outgoingDays: row.outgoing_days, auditDays: row.audit_days });
    return { policy, revision: row.revision as number, updatedAt: row.updated_at as number | null, actorId: row.actor_id as string | null };
  } catch { throw new HttpError(503, "retention_policy_unavailable"); }
}
