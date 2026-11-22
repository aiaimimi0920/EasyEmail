import type { Env } from "../contracts";
import { HttpError } from "../http";
import { endpointOrigins, environmentConfigs, parseProviderConfig, sameEndpoint } from "./config";
import type { ProviderConfig } from "./contracts";
import { MAX_PROVIDERS } from "../quota-policy";

export interface ProviderOverride {
  id: string; config_json: string; revision: number;
  secret_source: "environment" | "stored" | "none"; secret_cipher: string | null;
}
export interface ProviderState {
  config: ProviderConfig; revision: number; source: ProviderOverride["secret_source"]; cipher: string | null;
}

export async function providerStates(env: Env): Promise<ProviderState[]> {
  const baseline = environmentConfigs(env), origins = endpointOrigins(env, baseline);
  const states = new Map(baseline.map((config): [string, ProviderState] =>
    [config.id, { config: { ...config, revision: 0 }, revision: 0, source: "environment", cipher: null }]));
  const { results } = await env.DB.prepare("SELECT id,config_json,revision,secret_source,secret_cipher FROM provider_overrides").all<ProviderOverride>();
  for (const row of results) {
    let config: ProviderConfig;
    try { config = parseProviderConfig(env, JSON.parse(row.config_json)); }
    catch { throw new HttpError(503, "provider_config_invalid"); }
    if (config.id !== row.id || !origins.has(new URL(config.baseUrl).origin)) throw new HttpError(503, "provider_config_invalid");
    const original = baseline.find((item) => item.id === row.id);
    if (original && !sameEndpoint(original, config)) throw new HttpError(503, "provider_identity_conflict");
    states.set(row.id, { config: { ...config, revision: row.revision }, revision: row.revision, source: row.secret_source, cipher: row.secret_cipher });
  }
  if (states.size > MAX_PROVIDERS) throw new HttpError(503, "provider_config_invalid");
  return [...states.values()];
}

export async function providerState(env: Env, id: string, allowDisabled = false): Promise<ProviderState> {
  const state = (await providerStates(env)).find((row) => row.config.id === id);
  if (!state) throw new HttpError(404, "provider_not_found");
  if (!allowDisabled && !state.config.enabled) throw new HttpError(409, "provider_disabled");
  return state;
}

export async function assertProviderRevision(env: Env, config: ProviderConfig): Promise<ProviderState> {
  const current = await providerState(env, config.id, true);
  if (current.revision !== config.revision || !sameEndpoint(current.config, config)) throw new HttpError(409, "provider_config_changed");
  if (!current.config.enabled) throw new HttpError(409, "provider_disabled");
  return current;
}

// Embed in the write acquiring a reservation/lease; an earlier read alone is not a fence.
export const PROVIDER_REVISION_FENCE = "COALESCE((SELECT revision FROM provider_overrides WHERE id = ?), 0) = ?";
