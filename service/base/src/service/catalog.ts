import {
  DEFAULT_RUNTIME_TEMPLATES,
  DEFAULT_STRATEGY_PROFILES,
  MAIL_PROVIDER_TYPES,
  createDefaultProviderInstances,
} from "../defaults/index.js";
import type {
  MailStrategyModeResolution,
  ProviderCredentialBinding,
  ProviderCredentialSet,
  ProviderInstance,
  ProviderTypeDefinition,
  RuntimeTemplate,
  MailRoutingProfileDescriptor,
  StrategyProfile,
} from "../domain/models.js";
import { MailRegistry, type MailRegistrySeed } from "../domain/registry.js";
import { createDefaultMailProviderAdapters } from "../providers/index.js";
import type { MailProviderAdapter } from "../providers/contracts.js";
import {
  createDefaultDispatchStrategyRegistry,
  type DispatchStrategyRegistry,
} from "../strategies/index.js";
import type { MailAliasService } from "../alias/service.js";

export interface EasyEmailBootstrapCatalog {
  providerTypes?: ProviderTypeDefinition[];
  runtimeTemplates?: RuntimeTemplate[];
  strategyProfiles?: StrategyProfile[];
  providerInstances?: ProviderInstance[];
  credentialSets?: ProviderCredentialSet[];
  credentialBindings?: ProviderCredentialBinding[];
}

export interface EasyEmailBootstrapOptions extends EasyEmailBootstrapCatalog {
  registrySeed?: MailRegistrySeed;
  adapters?: MailProviderAdapter[];
  strategies?: DispatchStrategyRegistry;
  strictProviderMode?: boolean;
  defaultStrategyMode?: MailStrategyModeResolution;
  routingProfiles?: MailRoutingProfileDescriptor[];
  aliasService?: MailAliasService;
}

function cloneProviderTypes(items: ProviderTypeDefinition[]): ProviderTypeDefinition[] {
  return items.map((item) => ({ ...item, tags: [...item.tags] }));
}

function cloneRuntimeTemplates(items: RuntimeTemplate[]): RuntimeTemplate[] {
  return items.map((item) => ({ ...item, metadata: { ...item.metadata } }));
}

function cloneStrategies(items: StrategyProfile[]): StrategyProfile[] {
  return items.map((item) => ({
    ...item,
    preferredInstanceIds: item.preferredInstanceIds ? [...item.preferredInstanceIds] : undefined,
    metadata: { ...item.metadata },
  }));
}

function cloneInstances(items: ProviderInstance[]): ProviderInstance[] {
  return items.map((item) => ({
    ...item,
    hostBindings: [...item.hostBindings],
    groupKeys: [...item.groupKeys],
    metadata: { ...item.metadata },
  }));
}

function cloneCredentialSets(items: ProviderCredentialSet[]): ProviderCredentialSet[] {
  return items.map((item) => ({
    ...item,
    useCases: [...item.useCases],
    groupKeys: [...item.groupKeys],
    items: item.items.map((credentialItem) => ({
      ...credentialItem,
      metadata: { ...(credentialItem.metadata ?? {}) },
    })),
    metadata: { ...item.metadata },
  }));
}

function cloneCredentialBindings(items: ProviderCredentialBinding[]): ProviderCredentialBinding[] {
  return items.map((item) => ({
    ...item,
    useCases: item.useCases ? [...item.useCases] : undefined,
  }));
}

export function createEasyEmailRegistryFromCatalog(
  options: EasyEmailBootstrapCatalog = {},
  now: Date = new Date(),
): MailRegistry {
  return new MailRegistry({
    providerTypes: cloneProviderTypes(options.providerTypes ?? MAIL_PROVIDER_TYPES),
    runtimeTemplates: cloneRuntimeTemplates(options.runtimeTemplates ?? DEFAULT_RUNTIME_TEMPLATES),
    strategies: cloneStrategies(options.strategyProfiles ?? DEFAULT_STRATEGY_PROFILES),
    instances: cloneInstances(options.providerInstances ?? createDefaultProviderInstances(now)),
    credentialSets: cloneCredentialSets(options.credentialSets ?? []),
    credentialBindings: cloneCredentialBindings(options.credentialBindings ?? []),
  });
}

export function createDefaultEasyEmailProviderAdapters(): MailProviderAdapter[] {
  return createDefaultMailProviderAdapters();
}

export function createDefaultEasyEmailStrategyRegistry(): DispatchStrategyRegistry {
  return createDefaultDispatchStrategyRegistry();
}

export function mergeEasyEmailRegistrySeeds(
  persisted: MailRegistrySeed | undefined,
  explicit: MailRegistrySeed | undefined,
): MailRegistrySeed | undefined {
  if (!persisted && !explicit) {
    return undefined;
  }

  return {
    providerTypes: explicit?.providerTypes ?? persisted?.providerTypes,
    runtimeTemplates: explicit?.runtimeTemplates ?? persisted?.runtimeTemplates,
    instances: explicit?.instances ?? persisted?.instances,
    bindings: explicit?.bindings ?? persisted?.bindings,
    strategies: explicit?.strategies ?? persisted?.strategies,
    credentialSets: explicit?.credentialSets ?? persisted?.credentialSets,
    credentialBindings: explicit?.credentialBindings ?? persisted?.credentialBindings,
    sessions: explicit?.sessions ?? persisted?.sessions,
    messages: explicit?.messages ?? persisted?.messages,
  };
}
