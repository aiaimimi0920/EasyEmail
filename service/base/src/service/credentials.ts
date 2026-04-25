import {
  buildCredentialSummary,
  serializeCredentialSummary,
  type CredentialSetDefinition,
} from "../shared/index.js";
import type {
  EasyEmailSnapshot,
  ProviderCredentialBinding,
  ProviderCredentialSet,
  ProviderInstance,
} from "../domain/models.js";
import { MailRegistry } from "../domain/registry.js";

export function createCredentialNamespace(instance: ProviderInstance): string {
  return `mail:${instance.providerTypeKey}:${instance.id}`;
}

function createCredentialSetId(instanceId: string, index: number, rawId: string): string {
  const normalized = rawId.trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || `set-${index + 1}`;
  return `mailcred:${instanceId}:${index + 1}:${normalized}`;
}

export function materializeProviderCredentialSets(
  instance: ProviderInstance,
  credentialSets: CredentialSetDefinition[],
  now: Date,
): ProviderCredentialSet[] {
  const timestamp = now.toISOString();
  return credentialSets
    .filter((set) => Array.isArray(set.items) && set.items.length > 0)
    .map((set, index) => ({
      id: createCredentialSetId(instance.id, index, set.id),
      providerTypeKey: instance.providerTypeKey,
      displayName: set.displayName,
      useCases: [...set.useCases],
      strategy: set.strategy,
      priority: set.priority,
      groupKeys: [...instance.groupKeys],
      items: set.items.map((item) => ({
        ...item,
        metadata: { ...(item.metadata ?? {}) },
      })),
      metadata: { ...(set.metadata ?? {}) },
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
}

export function createProviderCredentialBindings(
  instanceId: string,
  credentialSets: ProviderCredentialSet[],
  now: Date,
): ProviderCredentialBinding[] {
  const updatedAt = now.toISOString();
  return credentialSets.map((credentialSet) => ({
    providerInstanceId: instanceId,
    credentialSetId: credentialSet.id,
    useCases: [...credentialSet.useCases],
    priority: credentialSet.priority ?? 0,
    updatedAt,
  }));
}

export function applyCredentialSetsToRegistry(
  registry: MailRegistry,
  instance: ProviderInstance,
  credentialSets: CredentialSetDefinition[],
  now: Date,
): {
  instance: ProviderInstance;
  credentialSets: ProviderCredentialSet[];
  credentialBindings: ProviderCredentialBinding[];
} {
  const previousSetIds = new Set(
    registry.resolveCredentialSetsForInstance(instance.id).map((item) => item.id),
  );
  const nextSets = materializeProviderCredentialSets(instance, credentialSets, now);
  const nextBindings = createProviderCredentialBindings(instance.id, nextSets, now);

  for (const credentialSet of nextSets) {
    registry.saveCredentialSet(credentialSet);
  }
  registry.deleteCredentialBindingsForInstance(instance.id);
  for (const binding of nextBindings) {
    registry.saveCredentialBinding(binding);
  }

  const nextSetIds = new Set(nextSets.map((item) => item.id));
  const activeBindingSetIds = new Set(registry.listCredentialBindings().map((binding) => binding.credentialSetId));
  for (const previousSetId of previousSetIds) {
    if (!nextSetIds.has(previousSetId) && !activeBindingSetIds.has(previousSetId)) {
      registry.deleteCredentialSet(previousSetId);
    }
  }

  const metadata = { ...instance.metadata };
  delete metadata.credentialSetsJson;
  delete metadata.credentialSummaryJson;

  if (nextSets.length > 0) {
    metadata.credentialSetsJson = JSON.stringify(nextSets);
    metadata.credentialSummaryJson = serializeCredentialSummary(
      buildCredentialSummary(createCredentialNamespace(instance), nextSets),
    );
  }

  const nextInstance: ProviderInstance = {
    ...instance,
    metadata,
    updatedAt: now.toISOString(),
  };
  registry.saveInstance(nextInstance);

  return {
    instance: nextInstance,
    credentialSets: nextSets,
    credentialBindings: nextBindings,
  };
}

export function resolveBoundCredentialSets(
  snapshot: EasyEmailSnapshot,
  providerInstanceId: string,
): ProviderCredentialSet[] {
  const setIds = new Set(
    snapshot.credentialBindings
      .filter((binding) => binding.providerInstanceId === providerInstanceId)
      .map((binding) => binding.credentialSetId),
  );

  return snapshot.credentialSets.filter((set) => setIds.has(set.id));
}
