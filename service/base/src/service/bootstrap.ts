import { MailRegistry } from "../domain/registry.js";
import { createEasyEmailService, type EasyEmailService, type EasyEmailServiceOptions } from "./easy-email-service.js";
import {
  createDefaultEasyEmailProviderAdapters,
  createDefaultEasyEmailStrategyRegistry,
  createEasyEmailRegistryFromCatalog,
  mergeEasyEmailRegistrySeeds,
  type EasyEmailBootstrapCatalog,
  type EasyEmailBootstrapOptions,
} from "./catalog.js";

export type { EasyEmailBootstrapCatalog, EasyEmailBootstrapOptions } from "./catalog.js";

export function createEasyEmailRegistrySeedFromCatalog(
  options: EasyEmailBootstrapCatalog = {},
  now: Date = new Date(),
): MailRegistry {
  return createEasyEmailRegistryFromCatalog(options, now);
}

export function createBootstrappedEasyEmailService(
  options: EasyEmailBootstrapOptions = {},
  now: Date = new Date(),
): EasyEmailService {
  const mergedSeed = mergeEasyEmailRegistrySeeds(
    options.registrySeed,
    createEasyEmailRegistryFromCatalog({
      providerTypes: options.providerTypes,
      runtimeTemplates: options.runtimeTemplates,
      strategyProfiles: options.strategyProfiles,
      providerInstances: options.providerInstances,
      credentialSets: options.credentialSets,
      credentialBindings: options.credentialBindings,
    }, now).snapshot(),
  );

  const registry = new MailRegistry(mergedSeed);
  const serviceOptions: EasyEmailServiceOptions = {
    registry,
    strategies: options.strategies ?? createDefaultEasyEmailStrategyRegistry(),
    adapters: options.adapters ?? createDefaultEasyEmailProviderAdapters(),
    strictProviderMode: options.strictProviderMode,
    defaultStrategyMode: options.defaultStrategyMode,
    routingProfiles: options.routingProfiles,
    aliasService: options.aliasService,
  };

  return createEasyEmailService(serviceOptions);
}
