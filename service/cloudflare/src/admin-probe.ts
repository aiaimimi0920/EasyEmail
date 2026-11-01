import { unixNow, type Env, type Identity } from "./contracts";
import { ADMIN_EXISTS, requireAdministrator } from "./admin-access";
import { healthView } from "./admin-store";
import { HttpError, json, readJson } from "./http";
import { probeProvider } from "./providers/probe";
import { configHash } from "./providers/config";
import { PROVIDER_REVISION_FENCE, providerState } from "./providers/settings";
import { rateLimit } from "./rate-limits";
import { allocationObservation, prepareAllocationState } from "./allocation-state";

export async function adminProbe(request: Request, env: Env, identity: Identity, id: string): Promise<Response> {
  if (Object.keys(await readJson(request)).length) throw new HttpError(400, "invalid_probe_request");
  const state = await providerState(env, id, true);
  // Public endpoints only probe connectivity in explicit anonymous mode, never API Key validity.
  if (["gptmail", "guerrillamail", "im215"].includes(state.config.type) || state.config.type === "duckmail" && state.config.authentication !== "anonymous") throw new HttpError(409, "provider_probe_unavailable");
  await rateLimit(env, "admin-probe", `${identity.userId}/${id}`, 3);
  await rateLimit(env, "admin-probe-global", "platform", 20);
  const snapshot = await prepareAllocationState(env, state.config);
  let errorCode: string | null = null;
  try { await probeProvider(env, state); }
  catch (error) { errorCode = error instanceof HttpError ? error.code : "provider_unavailable"; }
  const token = crypto.randomUUID(), now = unixNow();
  const observation = allocationObservation(env, snapshot, errorCode ? new HttpError(502, errorCode) : null, identity.userId);
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO provider_health(provider_id,config_revision,config_hash,checked_at,state,error_code,probe_token)
      SELECT ?,?,?,?,?,?,? WHERE ${PROVIDER_REVISION_FENCE} AND ${ADMIN_EXISTS}
      ON CONFLICT(provider_id) DO UPDATE SET config_revision=excluded.config_revision,config_hash=excluded.config_hash,checked_at=excluded.checked_at,
        state=excluded.state,error_code=excluded.error_code,probe_token=excluded.probe_token`)
      .bind(id, state.revision, await configHash(state.config), now, errorCode ? "error" : "ok", errorCode, token, id, state.revision, identity.userId),
    env.DB.prepare(`INSERT INTO admin_audit(id,actor_id,provider_id,action,revision,error_code,created_at)
      SELECT ?,?,?,'probe',?,?,? WHERE EXISTS (SELECT 1 FROM provider_health WHERE provider_id = ? AND probe_token = ?)`)
      .bind(token, identity.userId, id, state.revision, errorCode, now, id, token),
    ...(observation ? [observation] : []),
  ]);
  if (!results[0].meta.changes) {
    await requireAdministrator(request, env, identity);
    throw new HttpError(409, "provider_config_changed");
  }
  return json({ health: await healthView(env, state) });
}
