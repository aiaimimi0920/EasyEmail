import { unixNow, type Env, type Identity } from "./contracts";
import { ADMIN_EXISTS, requireAdministrator } from "./admin-access";
import { HttpError, json, readJson } from "./http";
import { CONFIG_FIELDS, endpointOrigins, environmentConfigs, parseProviderConfig, sameEndpoint } from "./providers/config";
import { parseProviderSecret, sealProviderSecret } from "./providers/secrets";
import { providerState, providerStates } from "./providers/settings";
import { providerView } from "./admin-store";
import { rateLimit } from "./rate-limits";
import type { ProviderConfig, ProviderSecret } from "./providers/contracts";
import { MAX_PROVIDERS } from "./quota-policy";

export async function saveAdminProvider(request: Request, env: Env, identity: Identity, id: string): Promise<Response> {
  const body = await readJson(request), action = body.secretAction;
  if (Object.keys(body).some((key) => !["expectedRevision", "config", "secretAction", "secret"].includes(key))
    || !Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0
    || !["keep", "replace", "clear"].includes(action as string)
    || (action !== "replace" && body.secret !== undefined)) throw new HttpError(400, "invalid_provider_request");
  let config: ProviderConfig, secret: ProviderSecret | undefined;
  try {
    config = parseProviderConfig(env, body.config);
    if (Object.keys(body.config as object).some((key) => !CONFIG_FIELDS.includes(key)) || config.id !== id) throw new Error();
    if (action === "replace") secret = parseProviderSecret(body.secret);
  } catch { throw new HttpError(400, "invalid_provider_request"); }
  const states = await providerStates(env), current = states.find((row) => row.config.id === id);
  if (current && !sameEndpoint(current.config, config)) throw new HttpError(409, "provider_identity_immutable");
  if (!endpointOrigins(env, environmentConfigs(env)).has(new URL(config.baseUrl).origin)) throw new HttpError(400, "provider_endpoint_denied");
  if ((current?.revision ?? 0) !== body.expectedRevision) throw new HttpError(409, "provider_config_changed");
  if (!current && states.length >= MAX_PROVIDERS) throw new HttpError(409, "provider_limit");
  await rateLimit(env, "admin-configure", identity.userId, 20);
  const source = action === "replace" ? "stored" : action === "clear" ? "none" : current?.source ?? "none";
  const cipher = secret ? await sealProviderSecret(env, config, secret) : source === "stored" ? current!.cipher : null;
  const revision = (body.expectedRevision as number) + 1, token = crypto.randomUUID(), now = unixNow();
  const baselineIds = environmentConfigs(env).map((row) => row.id);
  const countIds = baselineIds.length ? `id NOT IN (${baselineIds.map(() => "?").join(",")})` : "1";
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO provider_overrides(id,config_json,revision,secret_source,secret_cipher,change_token,updated_at)
      SELECT ?,?,?,?,?,?,? WHERE ${ADMIN_EXISTS} AND (? = 0 OR EXISTS (SELECT 1 FROM provider_overrides WHERE id = ? AND revision = ?)) AND
        (? = 1 OR EXISTS (SELECT 1 FROM provider_overrides WHERE id = ?) OR
          (SELECT COUNT(*) FROM provider_overrides WHERE ${countIds}) + ? < ${MAX_PROVIDERS})
      ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json,revision=excluded.revision,
        secret_source=excluded.secret_source,secret_cipher=excluded.secret_cipher,change_token=excluded.change_token,updated_at=excluded.updated_at
      WHERE provider_overrides.revision = ?`)
      .bind(id, JSON.stringify(config), revision, source, cipher, token, now, identity.userId,
        body.expectedRevision, id, body.expectedRevision, Number(baselineIds.includes(id)), id, ...baselineIds, baselineIds.length, body.expectedRevision),
    env.DB.prepare(`INSERT INTO admin_audit(id,actor_id,provider_id,action,revision,secret_action,created_at)
      SELECT ?,?,?,'configure',?,?,? WHERE EXISTS (SELECT 1 FROM provider_overrides WHERE id = ? AND revision = ? AND change_token = ?)`)
      .bind(token, identity.userId, id, revision, action, now, id, revision, token),
  ]);
  if (!results[0].meta.changes) {
    await requireAdministrator(request, env, identity);
    throw new HttpError(409, "provider_config_changed");
  }
  return json({ provider: await providerView(env, await providerState(env, id, true)) });
}
