import type { Env } from "../contracts";
import { HttpError } from "../http";
import { decryptCredential, encryptCredential } from "../mailbox-vault";
import { tokenHash } from "../security";
import type { ProviderConfig, ProviderSecret } from "./contracts";
import type { ProviderState } from "./settings";

export function parseProviderSecret(value: unknown): ProviderSecret {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid secret");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !["apiKey", "sitePassword"].includes(key))
    || typeof row.apiKey !== "string" || !row.apiKey || row.apiKey.length > 8192 || /[\x00-\x1f\x7f]/.test(row.apiKey)
    || (row.sitePassword !== undefined && (typeof row.sitePassword !== "string" || row.sitePassword.length > 8192
      || /[\x00-\x1f\x7f]/.test(row.sitePassword)))) throw new Error("invalid secret");
  return { apiKey: row.apiKey, ...(row.sitePassword === undefined ? {} : { sitePassword: row.sitePassword }) };
}

async function context(config: ProviderConfig) {
  const endpoint = await tokenHash(JSON.stringify([config.type, config.baseUrl]));
  return { id: `provider-secret-v1/${config.id}/${endpoint}`, user_id: "platform", provider_id: config.id };
}

export async function sealProviderSecret(env: Env, config: ProviderConfig, secret: ProviderSecret): Promise<string> {
  return encryptCredential(env, await context(config), { token: JSON.stringify(secret) });
}

export function environmentSecret(env: Env, id: string): ProviderSecret {
  const secrets: unknown = JSON.parse(env.PROVIDER_SECRETS ?? "{}");
  if (!secrets || typeof secrets !== "object" || Array.isArray(secrets) || !Object.hasOwn(secrets, id)) throw new Error("missing secret");
  return parseProviderSecret((secrets as Record<string, unknown>)[id]);
}

export async function providerSecret(env: Env, state: ProviderState): Promise<ProviderSecret> {
  try {
    if (state.source === "environment") return environmentSecret(env, state.config.id);
    if (state.source !== "stored") throw new Error("missing secret");
    const value = await decryptCredential(env, await context(state.config), state.cipher);
    return parseProviderSecret(JSON.parse(value.token ?? "null"));
  } catch { throw new HttpError(503, "provider_secret_unavailable"); }
}

export function secretConfigured(env: Env, state: ProviderState): boolean {
  if (state.source === "stored") return !!state.cipher;
  if (state.source === "none") return false;
  try { environmentSecret(env, state.config.id); return true; } catch { return false; }
}

export function providerAccessConfigured(env: Env, state: ProviderState): boolean {
  return ["duckmail", "guerrillamail"].includes(state.config.type) && state.config.authentication === "anonymous" || secretConfigured(env, state);
}
