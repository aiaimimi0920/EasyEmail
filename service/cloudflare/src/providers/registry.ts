import type { Env } from "../contracts";
import { HttpError } from "../http";
import { cloudflareProvider } from "./cloudflare";
import type { Provider, ProviderConfig } from "./contracts";
import { temporamProvider } from "./temporam";
import { validDomain } from "../mail-address";
import { assertProviderRevision, providerState, providerStates } from "./settings";
import { providerSecret } from "./secrets";
import { moemailProvider } from "./moemail";
import { gptmailProvider } from "./gptmail";
import { duckmailProvider } from "./duckmail";
import { guerrillamailProvider } from "./guerrillamail";
import { im215Provider } from "./im215";

export { validDomain } from "../mail-address";

export async function providerConfigs(env: Env): Promise<ProviderConfig[]> {
  return (await providerStates(env)).filter((row) => row.config.enabled).map((row) => row.config);
}

export async function configuredProvider(env: Env, id: string): Promise<ProviderConfig> {
  return (await providerState(env, id)).config;
}

export async function connectProvider(env: Env, config: ProviderConfig, parentSignal?: AbortSignal): Promise<Provider> {
  const state = await assertProviderRevision(env, config);
  const timeout = AbortSignal.timeout(15000), signal = parentSignal ? AbortSignal.any([timeout, parentSignal]) : timeout;
  if (config.type === "guerrillamail") return guerrillamailProvider(config, signal);
  if (config.type === "duckmail") return duckmailProvider(config, config.authentication === "anonymous" ? null : await providerSecret(env, state), signal);
  const secret = await providerSecret(env, state);
  if (config.type === "im215") return im215Provider(config, secret, signal);
  if (config.type === "moemail") return moemailProvider(config, secret, signal);
  if (config.type === "gptmail") return gptmailProvider(config, secret, signal);
  return config.type === "cloudflare" ? cloudflareProvider(config, secret, signal) : temporamProvider(config, secret, signal);
}

export async function availableDomains(env: Env, config: ProviderConfig, signal?: AbortSignal): Promise<string[]> {
  const domains = await (await connectProvider(env, config, signal)).domains();
  if (!domains.every(validDomain)) throw new HttpError(502, "provider_invalid_response");
  return [...new Set(domains.filter((domain) => config.domains.length === 0 || config.domains.includes(domain)))];
}
