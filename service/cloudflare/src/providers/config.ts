import type { Env } from "../contracts";
import { HttpError } from "../http";
import { mailAddress, validDomain } from "../mail-address";
import { parseCloudflareSendTransport } from "../../../base/src/domain/cloudflare-send-policy";
import type { ProviderConfig } from "./contracts";
import { MAX_PROVIDERS } from "../quota-policy";
import { tokenHash } from "../security";

export const CONFIG_FIELDS = ["id", "type", "baseUrl", "domains", "sendTransport", "sendRecipients", "enabled", "authentication"];
const loopback = (host: string) => ["localhost", "127.0.0.1", "[::1]"].includes(host);

export function parseProviderConfig(env: Env, value: unknown): ProviderConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid provider");
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !/^[a-z][a-z0-9-]{0,47}$/.test(row.id)
    || !["cloudflare", "temporam", "moemail", "gptmail", "duckmail", "guerrillamail", "im215"].includes(row.type as string) || typeof row.baseUrl !== "string"
    || row.baseUrl.length > 2048 || (row.enabled !== undefined && typeof row.enabled !== "boolean")) throw new Error("invalid provider");
  const url = new URL(row.baseUrl), app = new URL(env.APP_ORIGIN);
  const local = app.protocol === "http:" && loopback(app.hostname);
  if ((url.protocol !== "https:" && !(local && loopback(url.hostname) && url.protocol === "http:"))
    || url.username || url.password || url.search || url.hash) throw new Error("invalid endpoint");
  const domains = row.domains ?? [];
  if (!Array.isArray(domains) || domains.length > 100 || !domains.every((d) => typeof d === "string" && validDomain(d))
    || (["cloudflare", "gptmail", "guerrillamail"].includes(row.type as string) && domains.length === 0)) throw new Error("invalid domains");
  const sendTransport = parseCloudflareSendTransport(row.sendTransport), recipients = row.sendRecipients ?? [];
  if (row.type === "guerrillamail" ? row.authentication !== "anonymous"
    : row.authentication !== undefined && (row.type !== "duckmail" || !["api-key", "anonymous"].includes(row.authentication as string))) throw new Error("invalid authentication");
  if (!Array.isArray(recipients) || recipients.length > 100
    || !recipients.every((value) => value === "*" || mailAddress(value) === value)
    || (recipients.includes("*") && recipients.length !== 1)
    || (row.type !== "cloudflare" && (sendTransport || recipients.length))) throw new Error("invalid send policy");
  return { id: row.id, type: row.type as ProviderConfig["type"], baseUrl: url.href.replace(/\/$/, ""),
    domains: [...new Set(domains)], enabled: row.enabled ?? true, sendTransport,
    sendRecipients: [...new Set(recipients.map((address) => address.toLowerCase()))],
    ...(row.authentication === undefined ? {} : { authentication: row.authentication as ProviderConfig["authentication"] }) };
}

export function environmentConfigs(env: Env): ProviderConfig[] {
  try {
    const rows: unknown = JSON.parse(env.PROVIDER_CONFIG ?? "[]");
    if (!Array.isArray(rows) || rows.length > MAX_PROVIDERS) throw new Error();
    const configs = rows.map((row) => parseProviderConfig(env, row));
    if (new Set(configs.map((row) => row.id)).size !== configs.length) throw new Error();
    return configs;
  } catch { throw new HttpError(503, "provider_config_invalid"); }
}

export function endpointOrigins(env: Env, baseline: ProviderConfig[]): Set<string> {
  try {
    const extra: unknown = JSON.parse(env.PROVIDER_ENDPOINT_ORIGINS ?? "[]");
    if (!Array.isArray(extra) || extra.length > 20 || !extra.every((value) => {
      if (typeof value !== "string") return false;
      const url = new URL(value);
      return url.protocol === "https:" && url.origin === value;
    })) throw new Error();
    return new Set([...baseline.map((row) => new URL(row.baseUrl).origin), ...extra]);
  } catch { throw new HttpError(503, "provider_config_invalid"); }
}

export function sameEndpoint(a: ProviderConfig, b: ProviderConfig): boolean {
  return a.id === b.id && a.type === b.type && a.baseUrl === b.baseUrl;
}

export function configHash(config: ProviderConfig): Promise<string> {
  const { revision: _revision, ...metadata } = config;
  return tokenHash(JSON.stringify(metadata));
}
