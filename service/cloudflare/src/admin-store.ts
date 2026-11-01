import type { Env } from "./contracts";
import { HttpError, json, MAX_REQUEST_BYTES, pageOptions } from "./http";
import { providerAccessConfigured, secretConfigured } from "./providers/secrets";
import { providerStates, type ProviderState } from "./providers/settings";
import { configHash } from "./providers/config";
import { MAILBOX_QUOTAS, MAX_PROVIDERS, SEND_QUOTAS } from "./quota-policy";
import { MAX_ATTACHMENT_BYTES } from "./attachment-policy";
import { allocationState, allocationView } from "./allocation-state";

interface HealthRow { provider_id: string; config_revision: number; config_hash: string; checked_at: number; state: string; error_code: string | null }
export interface HealthView { state: string; checkedAt: number | null; error: string | null }

export async function healthView(env: Env, state: ProviderState): Promise<HealthView> {
  const row = await env.DB.prepare("SELECT provider_id,config_revision,config_hash,checked_at,state,error_code FROM provider_health WHERE provider_id = ?")
    .bind(state.config.id).first<HealthRow>();
  return row && row.config_revision === state.revision && row.config_hash === await configHash(state.config)
    ? { state: row.state, checkedAt: row.checked_at, error: row.error_code }
    : { state: "unknown", checkedAt: null, error: null };
}

export async function providerView(env: Env, state: ProviderState) {
  const { revision: _internal, ...config } = state.config;
  const allocation = await allocationState(env, state.config);
  return { config, revision: state.revision, secret: { source: state.source, configured: secretConfigured(env, state) },
    health: await healthView(env, state), allocation: { ...allocationView(allocation, providerAccessConfigured(env, state), state.config.enabled),
      failureCount: allocation?.failure_count ?? 0, lastError: allocation?.last_error ?? null,
      lastSuccessAt: allocation?.last_success_at ?? null, lastFailureAt: allocation?.last_failure_at ?? null } };
}

export async function listAdminProviders(env: Env): Promise<Response> {
  return json({ items: await Promise.all((await providerStates(env)).map((state) => providerView(env, state))) });
}

interface AuditRow {
  id: string; actor_id: string; provider_id: string; action: string; revision: number;
  secret_action: string | null; error_code: string | null; created_at: number;
}

export async function listAdminAudit(request: Request, env: Env): Promise<Response> {
  const { limit, cursor } = pageOptions(new URL(request.url));
  const after = cursor ? await env.DB.prepare("SELECT created_at FROM admin_audit WHERE id = ?").bind(cursor).first<{ created_at: number }>() : null;
  if (cursor && !after) throw new HttpError(400, "invalid_cursor");
  const { results } = await env.DB.prepare(`SELECT id,actor_id,provider_id,action,revision,secret_action,error_code,created_at FROM admin_audit
    ${after ? "WHERE created_at < ? OR (created_at = ? AND id < ?)" : ""} ORDER BY created_at DESC,id DESC LIMIT ?`)
    .bind(...(after ? [after.created_at, after.created_at, cursor] : []), limit + 1).all<AuditRow>();
  const items = results.slice(0, limit);
  return json({ items: items.map((row) => ({ id: row.id, actorId: row.actor_id, providerId: row.provider_id,
    action: row.action, revision: row.revision, secretAction: row.secret_action, error: row.error_code, createdAt: row.created_at })),
    nextCursor: results.length > limit ? items.at(-1)!.id : null });
}

export async function adminOverview(env: Env): Promise<Response> {
  const counts = await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM users) AS users,
    (SELECT COUNT(*) FROM mailboxes) AS mailboxes, (SELECT COUNT(*) FROM messages WHERE purged_at IS NULL) AS messages,
    (SELECT COUNT(*) FROM outgoing_messages) AS outgoing`).first();
  return json({ counts, limits: { readOnly: true, providers: MAX_PROVIDERS, ...MAILBOX_QUOTAS, ...SEND_QUOTAS,
    attachmentBytes: MAX_ATTACHMENT_BYTES, jsonRequestBytes: MAX_REQUEST_BYTES } });
}
