import type {
  EasyEmailSnapshot,
  ProviderCredentialSet,
  ProviderInstance,
} from "../domain/models.js";
import {
  buildCredentialSummary,
  createBasicAuthCredentialSetFromFile,
  createBasicAuthCredentialSetFromLines,
  createValueCredentialSetFromFile,
  createValueCredentialSetFromLines,
  parseCredentialSetsJson,
  serializeCredentialSummary,
  type CredentialSetDefinition,
} from "../shared/index.js";
import {
  createProviderCredentialBindings,
  materializeProviderCredentialSets,
  resolveBoundCredentialSets,
} from "../service/credentials.js";
import type { EasyEmailService } from "../service/easy-email-service.js";

function buildInlineCredentialSet(
  raw: string | undefined,
  options: {
    id: string;
    displayName: string;
    priority: number;
  },
): CredentialSetDefinition | undefined {
  if (!raw?.trim()) {
    return undefined;
  }

  return createValueCredentialSetFromLines(raw, {
    id: options.id,
    displayName: options.displayName,
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: options.priority,
  });
}

function buildFileCredentialSet(
  rawPath: string | undefined,
  options: {
    id: string;
    displayName: string;
    priority: number;
  },
): CredentialSetDefinition | undefined {
  if (!rawPath?.trim()) {
    return undefined;
  }

  return createValueCredentialSetFromFile(rawPath, {
    id: options.id,
    displayName: options.displayName,
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: options.priority,
  });
}

function buildInlineBasicAuthCredentialSet(
  username: string | undefined,
  password: string | undefined,
  options: {
    id: string;
    displayName: string;
    priority: number;
  },
): CredentialSetDefinition | undefined {
  if (!username?.trim() || !password?.trim()) {
    return undefined;
  }

  return createBasicAuthCredentialSetFromLines(`${username.trim()}|${password.trim()}`, {
    id: options.id,
    displayName: options.displayName,
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: options.priority,
  });
}

function buildBasicAuthCredentialSet(
  raw: string | undefined,
  options: {
    id: string;
    displayName: string;
    priority: number;
  },
): CredentialSetDefinition | undefined {
  if (!raw?.trim()) {
    return undefined;
  }

  return createBasicAuthCredentialSetFromLines(raw, {
    id: options.id,
    displayName: options.displayName,
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: options.priority,
  });
}

function buildBasicAuthCredentialSetFromFile(
  rawPath: string | undefined,
  options: {
    id: string;
    displayName: string;
    priority: number;
  },
): CredentialSetDefinition | undefined {
  if (!rawPath?.trim()) {
    return undefined;
  }

  return createBasicAuthCredentialSetFromFile(rawPath, {
    id: options.id,
    displayName: options.displayName,
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: options.priority,
  });
}

export function resolveAndPersistCredentialSets(
  service: EasyEmailService,
  snapshot: EasyEmailSnapshot,
  instance: ProviderInstance,
  effectiveSets: CredentialSetDefinition[],
): { formalSets: ProviderCredentialSet[]; now: Date } {
  const now = new Date();
  const persistedSets = resolveBoundCredentialSets(snapshot, instance.id);
  const formalSets = effectiveSets.length > 0
    ? materializeProviderCredentialSets(instance, effectiveSets, now)
    : persistedSets;

  if (effectiveSets.length > 0) {
    for (const credentialSet of formalSets) {
      service.saveCredentialSet(credentialSet);
    }
    service.replaceCredentialBindingsForInstance(instance.id, createProviderCredentialBindings(instance.id, formalSets, now));
  }

  return { formalSets, now };
}

export function buildProviderMetadataWithCredentials(
  instance: ProviderInstance,
  formalSets: ProviderCredentialSet[],
  extraMetadata: Record<string, string>,
): Record<string, string> {
  const { credentialSetsJson: _previousSets, credentialSummaryJson: _previousSummary, ...baseMetadata } = instance.metadata;
  const metadata: Record<string, string> = {
    ...baseMetadata,
    ...extraMetadata,
  };

  if (formalSets.length > 0) {
    metadata.credentialSetsJson = JSON.stringify(formalSets);
    metadata.credentialSummaryJson = serializeCredentialSummary(
      buildCredentialSummary(`mail:${instance.providerTypeKey}:${instance.id}`, formalSets),
    );
  }

  return metadata;
}

export function configureApiKeyProviderInstance(
  service: EasyEmailService,
  instanceId: string,
  providerTypeKey: ProviderInstance["providerTypeKey"],
  enabled: boolean,
  config: {
    baseUrl?: string;
    apiKey?: string;
    keysFile?: string;
    keysText?: string;
    credentialSetsJson?: string;
    domain?: string;
    extraMetadata?: Record<string, string | undefined>;
  },
  setLabels: {
    inlineId: string;
    inlineDisplayName: string;
    textId: string;
    textDisplayName: string;
    fileId: string;
    fileDisplayName: string;
  },
): void {
  const snapshot = service.getSnapshot();
  const instance = snapshot.instances.find((item) => item.id === instanceId && item.providerTypeKey === providerTypeKey);
  if (!instance) {
    return;
  }

  const configuredSets = parseCredentialSetsJson(config.credentialSetsJson);
  const inlineSet = buildInlineCredentialSet(config.apiKey, {
    id: setLabels.inlineId,
    displayName: setLabels.inlineDisplayName,
    priority: 200,
  });
  const textSet = buildInlineCredentialSet(config.keysText, {
    id: setLabels.textId,
    displayName: setLabels.textDisplayName,
    priority: 180,
  });
  const fileSet = buildFileCredentialSet(config.keysFile, {
    id: setLabels.fileId,
    displayName: setLabels.fileDisplayName,
    priority: 160,
  });

  const effectiveSets = configuredSets.length > 0
    ? configuredSets
    : [inlineSet, textSet, fileSet].filter((item): item is CredentialSetDefinition => item !== undefined);

  const { formalSets, now } = resolveAndPersistCredentialSets(service, snapshot, instance, effectiveSets);
  const metadata = buildProviderMetadataWithCredentials(instance, formalSets, {
    ...(config.baseUrl ? { apiBase: config.baseUrl } : {}),
    ...(config.domain ? { domain: config.domain } : {}),
    ...Object.fromEntries(
      Object.entries(config.extraMetadata ?? {}).filter(([, value]) => typeof value === "string" && value.trim()),
    ) as Record<string, string>,
  });

  service.saveProviderInstance({
    ...instance,
    status: enabled && formalSets.length > 0 ? "active" : "offline",
    connectionRef: config.baseUrl?.trim() || instance.connectionRef,
    metadata,
    updatedAt: now.toISOString(),
  });
}

export function configureBasicAuthProviderInstance(
  service: EasyEmailService,
  instanceId: string,
  providerTypeKey: ProviderInstance["providerTypeKey"],
  enabled: boolean,
  config: {
    baseUrl?: string;
    username?: string;
    password?: string;
    accountsFile?: string;
    accountsText?: string;
    credentialSetsJson?: string;
    domain?: string;
    extraMetadata?: Record<string, string | undefined>;
  },
  setLabels: {
    inlineId: string;
    inlineDisplayName: string;
    textId: string;
    textDisplayName: string;
    fileId: string;
    fileDisplayName: string;
  },
): void {
  const snapshot = service.getSnapshot();
  const instance = snapshot.instances.find((item) => item.id === instanceId && item.providerTypeKey === providerTypeKey);
  if (!instance) {
    return;
  }

  const configuredSets = parseCredentialSetsJson(config.credentialSetsJson);
  const inlineSet = buildInlineBasicAuthCredentialSet(config.username, config.password, {
    id: setLabels.inlineId,
    displayName: setLabels.inlineDisplayName,
    priority: 200,
  });
  const textSet = buildBasicAuthCredentialSet(config.accountsText, {
    id: setLabels.textId,
    displayName: setLabels.textDisplayName,
    priority: 180,
  });
  const fileSet = buildBasicAuthCredentialSetFromFile(config.accountsFile, {
    id: setLabels.fileId,
    displayName: setLabels.fileDisplayName,
    priority: 160,
  });

  const effectiveSets = configuredSets.length > 0
    ? configuredSets
    : [inlineSet, textSet, fileSet].filter((item): item is CredentialSetDefinition => item !== undefined);

  const { formalSets, now } = resolveAndPersistCredentialSets(service, snapshot, instance, effectiveSets);
  const metadata = buildProviderMetadataWithCredentials(instance, formalSets, {
    ...(config.baseUrl ? { apiBase: config.baseUrl } : {}),
    ...(config.domain ? { domain: config.domain } : {}),
    ...Object.fromEntries(
      Object.entries(config.extraMetadata ?? {}).filter(([, value]) => typeof value === "string" && value.trim()),
    ) as Record<string, string>,
  });

  service.saveProviderInstance({
    ...instance,
    status: enabled && formalSets.length > 0 ? "active" : "offline",
    connectionRef: config.baseUrl?.trim() || instance.connectionRef,
    metadata,
    updatedAt: now.toISOString(),
  });
}

export function configureMetadataOnlyExternalProviderInstance(
  service: EasyEmailService,
  instanceId: string,
  providerTypeKey: ProviderInstance["providerTypeKey"],
  enabled: boolean,
  config: {
    baseUrl?: string;
    extraMetadata?: Record<string, string | undefined>;
  },
): void {
  const snapshot = service.getSnapshot();
  const instance = snapshot.instances.find((item) => item.id === instanceId && item.providerTypeKey === providerTypeKey);
  if (!instance) {
    return;
  }

  const now = new Date();
  const metadata: Record<string, string> = {
    ...instance.metadata,
    ...Object.fromEntries(
      Object.entries(config.extraMetadata ?? {}).filter(([, value]) => typeof value === "string" && value.trim()),
    ) as Record<string, string>,
  };
  if (config.baseUrl?.trim()) {
    metadata.apiBase = config.baseUrl.trim();
  }

  service.saveProviderInstance({
    ...instance,
    status: enabled ? "active" : "offline",
    connectionRef: config.baseUrl?.trim() || instance.connectionRef,
    metadata,
    updatedAt: now.toISOString(),
  });
}
