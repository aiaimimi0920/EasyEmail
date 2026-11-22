import type { Env } from "../src/contracts";
import type { Provider, ProviderConfig, RandomProviderMailbox } from "../src/providers/contracts";
import { connectProvider as realConnect } from "../src/providers/registry";
import { object, providerJson } from "../src/providers/http";
export * from "../src/providers/registry";

// Test-only adapter for the platform allocation contract, not an implementation of any public supplier.
export async function connectProvider(env: Env, config: ProviderConfig, signal?: AbortSignal): Promise<Provider> {
  const base = await realConnect(env, config, signal);
  if (config.id !== "remote-fixture") return base;
  return { ...base, create: undefined, createCustom: undefined, customAddressCapability: undefined,
    async createRandom(domain: string) {
      return object(await providerJson(config.baseUrl, "/allocate", {}, signal ?? AbortSignal.timeout(15000), { domain }, { expectedStatus: 201 })) as unknown as RandomProviderMailbox;
    } };
}
