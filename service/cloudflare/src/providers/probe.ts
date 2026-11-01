import type { Env } from "../contracts";
import { HttpError } from "../http";
import { validDomain } from "../mail-address";
import { object, providerJson, string } from "./http";
import { providerSecret } from "./secrets";
import type { ProviderState } from "./settings";
import { temporamProvider } from "./temporam";
import { moemailProvider } from "./moemail";
import { duckmailProvider } from "./duckmail";

export async function probeProvider(env: Env, state: ProviderState): Promise<void> {
  const config = state.config, signal = AbortSignal.timeout(15000);
  if (["gptmail", "guerrillamail", "im215"].includes(config.type) || config.type === "duckmail" && config.authentication !== "anonymous") throw new HttpError(409, "provider_probe_unavailable");
  if (config.type === "duckmail") return validateDomains(config.domains, await duckmailProvider(config, null, signal).domains());
  const secret = await providerSecret(env, state);
  let domains: string[];
  if (config.type === "temporam") domains = await temporamProvider(config, secret, signal).domains();
  else if (config.type === "moemail") domains = await moemailProvider(config, secret, signal).domains();
  else {
    const row = object(await providerJson(config.baseUrl, "/admin/worker/configs", { "x-admin-auth": secret.apiKey,
      ...(secret.sitePassword ? { "x-custom-auth": secret.sitePassword } : {}) }, signal, undefined, { maxBytes: 262144, expectedStatus: 200 }));
    if (!Array.isArray(row.DOMAINS) || row.DOMAINS.length > 1000 || !string(row.VERSION, 100)) throw new HttpError(502, "provider_invalid_response");
    domains = row.DOMAINS.map((value) => string(value, 253));
  }
  validateDomains(config.domains, domains);
}

function validateDomains(allowed: string[], domains: string[]): void {
  if (!domains.length || !domains.every(validDomain)) throw new HttpError(502, "provider_invalid_response");
  if (allowed.some((domain) => !domains.includes(domain))) throw new HttpError(502, "provider_domains_mismatch");
}
