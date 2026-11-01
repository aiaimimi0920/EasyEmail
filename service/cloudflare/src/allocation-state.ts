import { unixNow, type Env } from "./contracts";
import { HttpError } from "./http";
import { configHash } from "./providers/config";
import type { ProviderConfig } from "./providers/contracts";
import { PROVIDER_REVISION_FENCE } from "./providers/settings";
import { ADMIN_EXISTS } from "./admin-access";
import { resolveFailureCooldownUntil, type MailboxFailureClass } from "../../base/src/service/outcome-policy";

export interface AllocationState {
  provider_id: string; config_revision: number; config_hash: string; observation_version: number; operation_sequence: number;
  allocation_count: number; failure_count: number; cooldown_until: number | null;
  last_error: string | null; last_failure_at: number | null; last_success_at: number | null;
}
const failureClasses: Record<string, MailboxFailureClass> = {
  provider_rate_limited: "capacity", provider_auth_failed: "auth", provider_timeout: "transient", provider_unavailable: "transient",
  provider_invalid_response: "unknown", provider_response_too_large: "unknown", provider_recipient_mismatch: "unknown",
  provider_domains_mismatch: "unknown",
};
export const ALLOCATION_COOLDOWN_FENCE = `EXISTS (SELECT 1 FROM provider_allocation_state WHERE provider_id = ?
  AND config_revision = ? AND config_hash = ? AND (cooldown_until IS NULL OR cooldown_until <= unixepoch()))`;

export async function allocationState(env: Env, config: ProviderConfig): Promise<AllocationState | null> {
  const row = await env.DB.prepare("SELECT * FROM provider_allocation_state WHERE provider_id=?").bind(config.id).first<AllocationState>();
  return row && row.config_revision === config.revision && row.config_hash === await configHash(config) ? row : null;
}

export async function prepareAllocationState(env: Env, config: ProviderConfig): Promise<AllocationState> {
  const hash = await configHash(config);
  await env.DB.prepare(`INSERT INTO provider_allocation_state(provider_id,config_revision,config_hash)
    SELECT ?,?,? WHERE ${PROVIDER_REVISION_FENCE} ON CONFLICT(provider_id) DO UPDATE SET
      config_revision=excluded.config_revision,config_hash=excluded.config_hash,
      observation_version=operation_sequence+1,operation_sequence=operation_sequence+1,
      failure_count=0,cooldown_until=NULL,last_error=NULL,last_failure_at=NULL,last_success_at=NULL
    WHERE config_revision<>excluded.config_revision OR config_hash<>excluded.config_hash`)
    .bind(config.id, config.revision!, hash, config.id, config.revision!).run();
  const row = await env.DB.prepare(`UPDATE provider_allocation_state SET operation_sequence=operation_sequence+1
    WHERE provider_id=? AND config_revision=? AND config_hash=? AND ${PROVIDER_REVISION_FENCE} RETURNING *`)
    .bind(config.id, config.revision!, hash, config.id, config.revision!).first<AllocationState>();
  if (!row) throw new HttpError(409, "provider_config_changed");
  return row;
}

export function allocationObservation(env: Env, snapshot: AllocationState, error: unknown = null, actorId?: string): D1PreparedStatement | null {
  const code = error instanceof HttpError && Object.hasOwn(failureClasses, error.code) ? error.code : null;
  if (error && !code) return null;
  const now = unixNow();
  const until = code ? Date.parse(resolveFailureCooldownUntil(failureClasses[code], new Date(now * 1000))!) / 1000 : null;
  const assignments = code ? `failure_count=failure_count+1,cooldown_until=MAX(COALESCE(cooldown_until,0),?),last_error=?,last_failure_at=?`
    : "failure_count=0,cooldown_until=NULL,last_error=NULL,last_success_at=?";
  return env.DB.prepare(`UPDATE provider_allocation_state SET ${assignments},observation_version=?
    WHERE provider_id=? AND config_revision=? AND config_hash=? AND observation_version<? AND ${PROVIDER_REVISION_FENCE}
    ${actorId ? `AND ${ADMIN_EXISTS}` : ""}`)
    .bind(...(code ? [until, code, now] : [now]), snapshot.operation_sequence, snapshot.provider_id, snapshot.config_revision, snapshot.config_hash,
      snapshot.operation_sequence, snapshot.provider_id, snapshot.config_revision, ...(actorId ? [actorId] : []));
}

export function allocationView(row: AllocationState | null, configured = true, enabled = true) {
  const cooling = row?.cooldown_until !== null && (row?.cooldown_until ?? 0) > unixNow();
  return { available: enabled && configured && !cooling, cooldownUntil: cooling ? row!.cooldown_until : null,
    state: !enabled ? "disabled" : !configured ? "unconfigured" : cooling ? "cooling" : "ready" };
}
