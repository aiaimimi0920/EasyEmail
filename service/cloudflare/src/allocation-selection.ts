import type { Env } from "./contracts";
import { HttpError } from "./http";
import { allocationObservation, allocationState, allocationView, prepareAllocationState, type AllocationState } from "./allocation-state";
import type { AllocationInput } from "./allocation-input";
import { availableDomains, configuredProvider, connectProvider } from "./providers/registry";
import { providerStates } from "./providers/settings";
import { providerAccessConfigured } from "./providers/secrets";
import type { ProviderConfig } from "./providers/contracts";

async function candidate(env: Env, config: ProviderConfig, input: AllocationInput, signal?: AbortSignal) {
  const snapshot = await prepareAllocationState(env, config);
  if (!allocationView(snapshot).available) throw new HttpError(409, "provider_cooling");
  try {
    let domains: string[];
    if (input.prefix !== undefined) {
      const provider = await connectProvider(env, config, signal);
      if (!provider.customAddressCapability || !provider.createCustom) throw new HttpError(409, 'custom_prefix_unavailable');
      const capability = await provider.customAddressCapability();
      if (!capability.enabled) throw new HttpError(409, 'custom_prefix_unavailable');
      if (input.prefix.length < capability.minLength || input.prefix.length > capability.maxLength) throw new HttpError(400, 'invalid_mailbox_prefix');
      domains = capability.domains;
    } else domains = await availableDomains(env, config, signal);
    const chosen = input.domain ?? domains[0];
    if (!chosen || !domains.includes(chosen)) throw new HttpError(400, "domain_unavailable");
    return { config, domain: chosen, snapshot };
  } catch (error) {
    const statement = allocationObservation(env, snapshot, error);
    if (statement) await statement.run();
    throw error;
  }
}

export async function selectAllocation(env: Env, input: AllocationInput): Promise<{ config: ProviderConfig; domain: string; snapshot: AllocationState }> {
  if (!input.automatic) return candidate(env, await configuredProvider(env, input.providerId!), input);
  const states = (await providerStates(env)).filter((state) => state.config.enabled && providerAccessConfigured(env, state)
    && (input.prefix === undefined || state.config.type === 'cloudflare')
    && (!input.domain || !state.config.domains.length || state.config.domains.includes(input.domain)));
  const candidates = await Promise.all(states.map(async (state) => ({ config: state.config, runtime: await allocationState(env, state.config) })));
  const eligible = candidates.filter((row) => allocationView(row.runtime).available)
    .sort((a, b) => (a.runtime?.allocation_count ?? 0) - (b.runtime?.allocation_count ?? 0) || a.config.id.localeCompare(b.config.id));
  const deadline = AbortSignal.timeout(8000);
  for (const row of eligible.slice(0, 3)) {
    if (deadline.aborted) break;
    try { return await candidate(env, row.config, input, AbortSignal.any([deadline, AbortSignal.timeout(2500)])); }
    catch (error) {
      if (!(error instanceof HttpError) || ![400, 409, 502].includes(error.status)
        && error.code !== "provider_secret_unavailable") throw error;
      if (error instanceof HttpError && ["provider_config_changed", "provider_disabled"].includes(error.code)) throw error;
    }
  }
  throw new HttpError(503, "allocation_unavailable");
}
